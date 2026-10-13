// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- plain Node port of the Pi store; no Effect services.
// The chat memory of the UniiChat gist (SPEC.md §1-§4), ported from the Pi
// implementation (dotfiles/pi-packages/pi-optchat-gist/src/memory.ts): an
// append-only log, a binary tree of one-line summaries built in the
// background, and a saved view that grows as a sawtooth. The compactor is a
// single injected `ask` call so tests can run without a model.
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { compressTask, mergeTask, SYSTEM, tooLong } from "./prompts.ts";

export const NODE = 512;
/** The view grows to HIGH bytes, then one batch merges it down to LOW (§3.2). */
export const VIEW = { low: 64_000, high: 128_000 };
/** The compaction view: the same sawtooth, smaller (§4). */
export const CVIEW = { low: 16_000, high: 32_000 };
export const JOBS = 8;
export const TRIES = 5;
export const CAP = 30_000;
export const PLACEHOLDER = "(not summarized yet: zoom it)";

export type Kind = "user" | "talk" | "tool" | "echo" | "work" | "note";
export interface Message {
  i: number;
  kind: Kind;
  text: string;
  size: number;
  date: string;
}
export interface Part {
  l: number;
  i: number;
}
/** One compactor call: prompt in (SYSTEM is prepended by the caller path), summary line out. */
export type Ask = (prompt: string, signal: AbortSignal) => Promise<string>;
export interface Band {
  low: number;
  high: number;
}

export const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const flat = (text: string): string => text.replace(/\r?\n/g, " ");
const key = (l: number, i: number): string => `${l}:${i}`;
const start = (part: Part): number => part.i * 2 ** part.l;
export const name = (l: number, i: number): string => `${i * 2 ** l}+${2 ** l}`;

/** Cut to at most `limit` bytes without splitting a UTF-8 character. */
export function cutBytes(text: string, limit: number): string {
  return Buffer.from(text, "utf8")
    .subarray(0, limit)
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
}
/** Keep head and tail of an oversized tool result, with a note of what was cut (§1). */
export function capText(text: string, limit = CAP): string {
  if (text.length <= limit) return text;
  const marker = `\n[... ${text.length - limit} of ${text.length} characters cut here ...]\n`;
  const room = Math.max(0, limit - marker.length);
  return (
    text.slice(0, Math.ceil(room / 2)) + marker + text.slice(text.length - Math.floor(room / 2))
  );
}
/** Any other long text is never cut: it becomes several messages in a row (§1). */
export function pages(text: string, limit = CAP): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = limit;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}
function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function formatDate(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const zone = `${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`;
}

/** Append-only JSONL streams split by local day; one write and fsync per line. */
class Stream {
  private fd: number | undefined;
  private day = "";
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  static load(directory: string, writable: boolean): { rows: unknown[]; torn: number } {
    const rows: unknown[] = [];
    let torn = 0;
    if (!existsSync(directory)) return { rows, torn };
    for (const file of readdirSync(directory)
      .filter((file) => file.endsWith(".jsonl"))
      .sort()) {
      const path = join(directory, file);
      const content = readFileSync(path, "utf8");
      for (const line of content.split("\n")) {
        if (!line) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          torn++;
        }
      }
      if (writable && content.length > 0 && !content.endsWith("\n")) appendFileSync(path, "\n");
    }
    return { rows, torn };
  }
  write(row: object): void {
    const day = localDay(new Date());
    if (this.fd === undefined || day !== this.day) {
      this.close();
      mkdirSync(this.directory, { recursive: true });
      this.fd = openSync(join(this.directory, `${day}.jsonl`), "a", 0o600);
      this.day = day;
    }
    writeSync(this.fd, `${JSON.stringify(row)}\n`);
    fsyncSync(this.fd);
  }
  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }
}

/**
 * The most due adjacent sibling pair whose parent is built, as an index into `parts`, or -1 (§3.2).
 * due = (T - last) / 2^l, from the pair's LAST message; equal pairs merge oldest first.
 */
export function mostDue(
  parts: ReadonlyArray<Part>,
  total: number,
  built: (l: number, i: number) => boolean,
): number {
  let best = -1,
    due = -Infinity;
  for (let index = 0; index + 1 < parts.length; index++) {
    const a = parts[index]!,
      b = parts[index + 1]!;
    if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1 || !built(a.l + 1, a.i / 2)) continue;
    const candidate = (total - ((a.i + 2) * 2 ** a.l - 1)) / 2 ** a.l;
    if (candidate > due) {
      best = index;
      due = candidate;
    }
  }
  return best;
}

export interface MemoryOptions {
  writable: boolean;
  ask?: Ask;
  /** The system prompt prepended to every compaction call (SYSTEM by default). */
  system?: string;
  /** Reported once per failing node. */
  report?: (error: unknown, l: number, i: number) => void;
  node?: number;
  view?: Band;
  cview?: Band;
  jobs?: number;
}

export class Memory {
  readonly messages: Message[] = [];
  private readonly nodes = new Map<string, string>();
  private readonly notFree = new Set<string>();
  private view: Part[] = [];
  private draining = false;
  private cview: Part[] = [];
  private readonly leaves: number[] = [];
  private merges: Part[] = [];
  private readonly busy = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly reported = new Set<string>();
  private readonly waiters = new Set<() => void>();
  private readonly controller = new AbortController();
  private readonly main: Stream;
  private readonly tree: Stream;
  private readonly viewPath: string;
  readonly torn: number;
  readonly limit: { node: number; view: Band; cview: Band; jobs: number };
  paused = false;
  calls = 0;
  lastError: string | undefined;

  readonly directory: string;
  private readonly options: MemoryOptions;
  constructor(directory: string, options: MemoryOptions) {
    this.directory = directory;
    this.options = options;
    this.limit = {
      node: options.node ?? NODE,
      view: options.view ?? VIEW,
      cview: options.cview ?? CVIEW,
      jobs: options.jobs ?? JOBS,
    };
    const chat = join(directory, "chat");
    this.main = new Stream(join(chat, "main"));
    this.tree = new Stream(join(chat, "tree"));
    this.viewPath = join(chat, "view.json");
    const log = Stream.load(join(chat, "main"), options.writable),
      nodes = Stream.load(join(chat, "tree"), options.writable);
    for (const row of log.rows as Message[])
      if (row.i === this.messages.length) this.messages.push(row);
    for (const row of nodes.rows as Array<{ l: number; i: number; text: string }>)
      this.nodes.set(key(row.l, row.i), row.text);
    this.torn = log.torn + nodes.torn;
    this.queueAll();
    const saved = this.loadView();
    if (saved) {
      this.view = saved;
      for (let i = this.covered(saved); i < this.messages.length; i++) this.view.push({ l: 0, i });
    } else {
      for (let i = 0; i < this.messages.length; i++) {
        this.view.push({ l: 0, i });
        this.fitView();
      }
    }
    this.resetCompactionView();
    if (options.writable) this.saveView();
  }

  get total(): number {
    return this.messages.length;
  }
  get size(): number {
    return this.sizeOf(this.view);
  }
  get compactionSize(): number {
    return this.sizeOf(this.cview);
  }
  get pending(): number {
    return this.unbuilt().length;
  }
  unbuilt(upTo = Infinity): Part[] {
    return this.view.filter(
      (part) => start(part) < upTo && this.node(part.l, part.i) === undefined,
    );
  }
  get running(): number {
    return this.busy.size;
  }
  parts(): ReadonlyArray<Readonly<Part>> {
    return this.view;
  }

  log(kind: Kind, text: string): Message[] {
    if (!this.options.writable) throw new Error("chat memory is read-only in this process");
    const logged: Message[] = [];
    for (const page of pages(text)) {
      const message: Message = {
        i: this.messages.length,
        kind,
        text: page,
        size: bytes(`${kind}: ${page}`),
        date: new Date().toISOString(),
      };
      this.main.write(message);
      this.messages.push(message);
      this.view.push({ l: 0, i: message.i });
      this.cview.push({ l: 0, i: message.i });
      if (this.node(0, message.i) === undefined) this.leaves.push(message.i);
      else this.built(0, message.i);
      logged.push(message);
    }
    this.retry();
    this.fitView();
    this.saveView();
    this.pump();
    return logged;
  }

  node(l: number, i: number): string | undefined {
    const id = key(l, i);
    const stored = this.nodes.get(id);
    if (stored !== undefined) return stored;
    if (this.notFree.has(id) || (i + 1) * 2 ** l > this.messages.length) return undefined;
    let free: string | undefined;
    if (l === 0) {
      const message = this.messages[i]!;
      free = `${message.kind}: ${message.text}`;
    } else {
      const a = this.node(l - 1, 2 * i),
        b = this.node(l - 1, 2 * i + 1);
      if (a === undefined || b === undefined) return undefined;
      free = `${a}\n${b}`;
    }
    if (bytes(free) > this.limit.node) {
      this.notFree.add(id);
      return undefined;
    }
    this.nodes.set(id, free);
    return free;
  }

  private line(part: Part): string {
    return `${name(part.l, part.i)}|${flat(this.node(part.l, part.i) ?? PLACEHOLDER)}\n`;
  }
  private sizeOf(parts: Part[]): number {
    return parts.reduce((sum, part) => sum + bytes(this.line(part)), 0);
  }
  private covered(parts: Part[]): number {
    const last = parts.at(-1);
    return last ? start(last) + 2 ** last.l : 0;
  }

  private merge(parts: Part[], target: number): boolean {
    const total = this.messages.length,
      built = (l: number, i: number) => this.node(l, i) !== undefined;
    let size = this.sizeOf(parts),
      merged = false;
    while (size > target) {
      const best = mostDue(parts, total, built);
      if (best < 0) break;
      const a = parts[best]!,
        b = parts[best + 1]!,
        parent = { l: a.l + 1, i: a.i / 2 };
      size += bytes(this.line(parent)) - bytes(this.line(a)) - bytes(this.line(b));
      parts.splice(best, 2, parent);
      merged = true;
    }
    return merged;
  }

  private fitView(): void {
    if (this.size > this.limit.view.high) this.draining = true;
    if (this.draining) {
      const merged = this.merge(this.view, this.limit.view.low);
      if (this.size <= this.limit.view.low) this.draining = false;
      if (merged) {
        this.resetCompactionView();
        return;
      }
    }
    if (this.compactionSize > this.limit.cview.high) this.merge(this.cview, this.limit.cview.low);
  }
  private resetCompactionView(): void {
    this.cview = this.view.map((part) => ({ ...part }));
    this.merge(this.cview, this.limit.cview.low);
  }

  private loadView(): Part[] | undefined {
    if (!existsSync(this.viewPath)) return undefined;
    try {
      const pairs = JSON.parse(readFileSync(this.viewPath, "utf8")) as Array<[number, number]>;
      const parts = pairs.map(([l, i]) => ({ l, i }));
      let next = 0;
      for (const part of parts) {
        if (
          !Number.isSafeInteger(part.l) ||
          !Number.isSafeInteger(part.i) ||
          part.l < 0 ||
          start(part) !== next
        )
          return undefined;
        next += 2 ** part.l;
      }
      return next <= this.messages.length ? parts : undefined;
    } catch {
      return undefined;
    }
  }
  private saveView(): void {
    mkdirSync(join(this.directory, "chat"), { recursive: true });
    const temp = `${this.viewPath}.tmp`;
    const fd = openSync(temp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(this.view.map((part) => [part.l, part.i])));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.viewPath);
  }

  private queueAll(): void {
    const total = this.messages.length;
    for (let i = 0; i < total; i++) if (this.node(0, i) === undefined) this.leaves.push(i);
    for (let l = 1; 2 ** l <= total; l++) {
      for (let i = 0; (i + 1) * 2 ** l <= total; i++) {
        if (
          this.node(l, i) === undefined &&
          this.node(l - 1, 2 * i) !== undefined &&
          this.node(l - 1, 2 * i + 1) !== undefined
        )
          this.merges.push({ l, i });
      }
    }
  }
  private built(l: number, i: number): void {
    if (l === 0) {
      const at = this.leaves.indexOf(i);
      if (at >= 0) this.leaves.splice(at, 1);
    }
    if (this.node(l, i ^ 1) === undefined) return;
    const parent = { l: l + 1, i: i >> 1 };
    if (this.node(parent.l, parent.i) !== undefined) this.built(parent.l, parent.i);
    else this.merges.push(parent);
  }

  retry(): void {
    if (!this.failed.size) return;
    this.failed.clear();
    this.pump();
  }

  pump(): void {
    if (
      !this.options.writable ||
      !this.options.ask ||
      this.paused ||
      this.controller.signal.aborted
    )
      return;
    for (const i of this.leaves.slice(0, this.limit.jobs)) {
      if (this.busy.size >= this.limit.jobs) return;
      this.start(0, i);
    }
    const waiting: Part[] = [];
    while (this.merges.length && this.busy.size < this.limit.jobs) {
      const part = this.merges.shift()!;
      if (this.failed.has(key(part.l, part.i))) waiting.push(part);
      else this.start(part.l, part.i);
    }
    this.merges.unshift(...waiting);
  }

  private start(l: number, i: number): void {
    const id = key(l, i);
    if (this.busy.has(id) || this.failed.has(id) || this.nodes.has(id)) return;
    this.busy.add(id);
    this.build(l, i).then(
      () => {
        this.busy.delete(id);
        this.reported.delete(id);
        this.lastError = undefined;
        this.pump();
      },
      (error) => {
        this.busy.delete(id);
        if (this.controller.signal.aborted) return;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.failed.add(id);
        if (l > 0) this.merges.push({ l, i });
        if (!this.reported.has(id)) {
          this.reported.add(id);
          this.options.report?.(error, l, i);
        }
        this.wake();
      },
    );
  }

  compactorInput(l: number, i: number): [string, string] {
    const last = l === 0 ? i - 1 : (i + 1) * 2 ** l - 1;
    const lines: string[] = [];
    for (const part of this.cview) {
      if (start(part) > last || this.node(part.l, part.i) === undefined) break;
      lines.push(this.line(part));
    }
    const context = `<chat>\n${lines.join("")}</chat>`;
    if (l === 0) {
      const message = this.messages[i]!;
      return [context, compressTask(i, `${message.kind}: ${message.text}`, this.limit.node)];
    }
    const a = this.node(l - 1, 2 * i)!,
      b = this.node(l - 1, 2 * i + 1)!;
    return [
      context,
      mergeTask(
        name(l - 1, 2 * i),
        name(l - 1, 2 * i + 1),
        i * 2 ** l,
        last,
        flat(a),
        flat(b),
        this.limit.node,
      ),
    ];
  }

  private async build(l: number, i: number): Promise<void> {
    const ask = this.options.ask!;
    const [context, task] = this.compactorInput(l, i);
    const system = this.options.system ?? SYSTEM;
    let prompt = `${system}\n\n${context}\n\n${task}`;
    const tries: string[] = [];
    for (;;) {
      this.calls++;
      const line = (await ask(prompt, this.controller.signal)).trim();
      if (!line) throw new Error(`empty summary for node ${name(l, i)}`);
      tries.push(line);
      const size = bytes(line);
      if (size <= this.limit.node || tries.length >= TRIES) break;
      prompt = `${prompt}\n\n${tooLong(size, cutBytes(line, this.limit.node), this.limit.node)}`;
    }
    if (this.controller.signal.aborted) throw new Error("memory closed");
    const text = tries.reduce((best, line) => (bytes(line) < bytes(best) ? line : best));
    this.tree.write({ l, i, text, size: bytes(text) });
    this.nodes.set(key(l, i), text);
    this.built(l, i);
    this.wake();
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
  settle(signal?: AbortSignal, upTo = Infinity): Promise<boolean> {
    this.retry();
    return new Promise((resolve) => {
      const check = () => {
        if (signal?.aborted || this.controller.signal.aborted) return done(false);
        const unbuilt = this.unbuilt(upTo);
        if (!unbuilt.length) return done(true);
        if (unbuilt.some((part) => this.failed.has(key(part.l, part.i)))) return done(false);
      };
      const done = (value: boolean) => {
        this.waiters.delete(check);
        signal?.removeEventListener("abort", check);
        resolve(value);
      };
      this.waiters.add(check);
      signal?.addEventListener("abort", check);
      check();
    });
  }

  render(): string {
    return `<chat>\n${this.view.map((part) => this.line(part)).join("")}</chat>`;
  }

  zoom(id: number, n: number): string {
    const valid =
      Number.isSafeInteger(id) &&
      Number.isSafeInteger(n) &&
      id >= 0 &&
      n >= 1 &&
      (n & (n - 1)) === 0 &&
      id % n === 0 &&
      id + n <= this.messages.length;
    if (!valid) return `No line ${id}+${n}.`;
    if (n === 1) {
      const message = this.messages[id]!;
      return `${id}+0|${message.kind}: ${message.text}`;
    }
    const l = Math.log2(n) - 1,
      i = (2 * id) / n,
      half = n / 2;
    return [i, i + 1]
      .map((child) => `${child * half}+${half}|${flat(this.node(l, child) ?? PLACEHOLDER)}`)
      .join("\n");
  }

  date(id: number): string {
    const message = Number.isSafeInteger(id) ? this.messages[id] : undefined;
    return message ? formatDate(message.date) : `No message ${id}.`;
  }

  close(): void {
    this.controller.abort();
    this.wake();
    this.main.close();
    this.tree.close();
  }
}

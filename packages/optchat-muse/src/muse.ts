// @effect-diagnostics globalTimers:off -- plain Node MSP host; no Effect timers.
// A minimal Muse MSP host for OptChat, following provider-muse's SDK
// patterns (spawn `muse serve`, session/start, turn/start, item
// notifications) without the Effect/orchestration layer. Every OptChat turn
// and every compaction runs in a FRESH native session (SPEC.md §6): the
// rendered view is the only continuity.
import { spawnMspConnection, type Connection, type ProcessExit } from "@muse-code/sdk";
import type { Kind } from "./memory.ts";

export interface MuseHost {
  readonly connection: Pick<
    Connection,
    | "command"
    | "mintCommandId"
    | "onNotification"
    | "onServerRequest"
    | "onProtocolError"
    | "closed"
  >;
  readonly grantedCapabilities: readonly string[];
  readonly exited: Promise<ProcessExit>;
  close(): Promise<void>;
}

export interface MuseHostOptions {
  /** Path or PATH name of the muse binary ("muse" by default). */
  binaryPath?: string;
  cwd?: string;
  /** Read-only hosts get no shell or writes; compactor hosts are read-only. */
  readOnly?: boolean;
  startupTimeoutMs?: number;
}

function serveArgs(readOnly: boolean): string[] {
  if (readOnly) return ["serve", "--disable-shell", "--disable-write"];
  return ["serve", "--trust-workspace"];
}

export async function createMuseHost(options: MuseHostOptions = {}): Promise<MuseHost> {
  const readOnly = options.readOnly === true;
  const handshake = spawnMspConnection({
    command: options.binaryPath ?? "muse",
    args: serveArgs(readOnly),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    shutdownTimeoutMs: 10_000,
  });
  let closePromise: Promise<void> | undefined;
  const close = () => (closePromise ??= handshake.close().then(() => undefined));
  let rejectStartup: (reason: unknown) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectStartup = reject;
  });
  const timer = setTimeout(
    () => rejectStartup(new Error("Muse SDK initialization timed out.")),
    options.startupTimeoutMs ?? 20_000,
  );
  timer.unref();
  try {
    const host = await Promise.race([
      handshake.initialize({
        clientInfo: { name: "optchat_muse", title: "OptChat (Muse)", version: "0.1.0" },
        capabilities: { requestedCapabilities: readOnly ? [] : ["sessionMcp"] },
      }),
      interrupted,
    ]);
    if (host.initializeResult.schema?.version !== 1) {
      throw new Error("Muse SDK returned an unsupported protocol envelope version.");
    }
    return {
      connection: host.connection,
      grantedCapabilities: (host.initializeResult.grantedCapabilities ??
        []) as unknown as readonly string[],
      exited: host.exited,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export interface TurnItem {
  /** OptChat kind this item logs as. */
  kind: Extract<Kind, "talk" | "tool" | "echo" | "work">;
  text: string;
}

export interface FreshTurnOptions {
  workspaceRoot: string;
  prompt: string;
  modelId?: string;
  /** session/start `config` (e.g. the optchat MCP servers entry). */
  config?: Record<string, unknown>;
  /** promptUnmatched (default), allowAll, or denyUnmatched for compactions. */
  approvalMode?: string;
  signal?: AbortSignal;
  /** Called as each item completes, for live logging (§6). */
  onItem?: (item: TurnItem) => void;
}

interface RawItem {
  itemId: string;
  kind: string;
  revision: number;
  turnId?: string;
  text?: string;
  toolName?: string;
  name?: string;
  retracted?: boolean;
  truncated?: boolean;
}

/** Map an MSP item to an OptChat message. Thoughts are never logged (§1). */
export function classifyItem(item: RawItem): TurnItem | undefined {
  const text = item.text ?? "";
  const kind = item.kind.toLowerCase();
  if (kind.includes("reason") || kind.includes("thought") || kind.includes("thinking"))
    return undefined;
  if (kind.includes("subagent") || kind.includes("child") || kind.includes("workflow")) {
    return text ? { kind: "work", text } : undefined;
  }
  if (kind.includes("tool") && (kind.includes("result") || kind.includes("output"))) {
    return { kind: "echo", text };
  }
  if (kind.includes("tool")) {
    return { kind: "tool", text: text || `${item.toolName ?? item.name ?? "tool"} {}` };
  }
  if (kind.includes("message") || kind === "agentmessage") {
    return text && !item.retracted ? { kind: "talk", text } : undefined;
  }
  return undefined;
}

/**
 * Run one turn in a fresh native session and return its loggable items in
 * completion order. The session is discarded with the host session map —
 * nothing carries over but what the caller puts in the store (§6).
 */
export async function runFreshTurn(host: MuseHost, options: FreshTurnOptions): Promise<TurnItem[]> {
  const { signal } = options;
  let sessionId: string | undefined;
  const turnId = host.connection.mintCommandId();
  const latest = new Map<string, RawItem>();
  const items: TurnItem[] = [];
  let resolveCompletion: (items: TurnItem[]) => void = () => {};
  let rejectCompletion: (error: unknown) => void = () => {};
  const completion = new Promise<TurnItem[]>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => {});
  const record = (item: RawItem) => {
    const previous = latest.get(item.itemId);
    if (previous && item.revision <= previous.revision) return;
    latest.set(item.itemId, item);
  };
  host.connection.onNotification((notification) => {
    try {
      const params = (notification.params ?? {}) as Record<string, unknown> & {
        item?: RawItem;
        sessionId?: string;
        turnId?: string;
        terminal?: string;
        error?: { message?: string };
      };
      if (notification.method === "item/completed" || notification.method === "item/updated") {
        const item = params.item;
        if (!item || params.sessionId !== sessionId || item.turnId !== turnId) return;
        record(item);
        if (notification.method === "item/completed") {
          const classified = classifyItem(item);
          if (classified) {
            items.push(classified);
            options.onItem?.(classified);
          }
        }
      } else if (notification.method === "turn/completed") {
        if (params.sessionId !== sessionId || params.turnId !== turnId) return;
        if (params.terminal === "completed") resolveCompletion(items);
        else rejectCompletion(new Error(params.error?.message ?? `Muse turn ${params.terminal}.`));
      } else if (notification.method === "view/gap") {
        rejectCompletion(new Error("Muse turn lost part of its response (view/gap)."));
      }
    } catch (error) {
      rejectCompletion(error);
    }
  });
  host.connection.onProtocolError(rejectCompletion);
  void host.connection.closed.then(() =>
    rejectCompletion(new Error("Muse connection closed before the turn completed.")),
  );
  void host.exited.then(() =>
    rejectCompletion(new Error("Muse exited before the turn completed.")),
  );
  const onAbort = () => rejectCompletion(signal?.reason ?? new Error("turn aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const started = (await host.connection.command("session/start", {
      workspaceRoot: options.workspaceRoot,
      providerId: "meta",
      ...(options.modelId ? { modelId: options.modelId } : {}),
      ...(options.config ? { config: options.config } : {}),
      approvalMode: options.approvalMode ?? "promptUnmatched",
    })) as { session: { sessionId: string } };
    sessionId = started.session.sessionId;
    const acknowledged = host.connection.command(
      "turn/start",
      { sessionId, input: [{ type: "text", text: options.prompt }] },
      { commandId: turnId },
    );
    return await Promise.race([acknowledged.then(() => completion), completion]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** A compactor `ask`: one fresh read-only session, final message text out (§4). */
export function makeCompactorAsk(host: MuseHost, workspaceRoot: string, modelId?: string) {
  return async (prompt: string, signal: AbortSignal): Promise<string> => {
    const items = await runFreshTurn(host, {
      workspaceRoot,
      prompt,
      ...(modelId ? { modelId } : {}),
      approvalMode: "denyUnmatched",
      signal,
    });
    return items.filter((item) => item.kind === "talk").at(-1)?.text ?? "";
  };
}

// @effect-diagnostics nodeBuiltinImport:off -- plain Node driver; no Effect services.
// The OptChat driver for Muse (SPEC.md §6): one endless chat per
// project, a fresh native Muse session per user message, the rendered view
// as the only continuity. Tool results are clipped (§1); subagent reports
// land as `work` messages; zoom/date are served to the session over MCP.
import { Memory, capText, type Ask, type Kind } from "./memory.ts";
import { serveOptChatTools, type OptChatMcpServer } from "./mcp.ts";
import {
  createMuseHost,
  makeCompactorAsk,
  runFreshTurn,
  type MuseHost,
  type TurnItem,
} from "./muse.ts";
import { SYSTEM } from "./prompts.ts";
import { acquireLock, storeFor, STORE_ENV, type ChatLock } from "./store.ts";

export interface OptChatOptions {
  /** Working directory the chat belongs to; its project picks the store. */
  cwd: string;
  /** Explicit store directory (tests); default: one store per project. */
  store?: string;
  /** User instructions appended after SYSTEM (the user's AGENTS.md content). */
  instructions?: string;
  binaryPath?: string;
  /** Model for turns; Muse picks when omitted. */
  modelId?: string;
  /** Cheap model for compactions; turns' model when omitted. */
  compactorModelId?: string;
  /** Serve zoom/date over MCP to turn sessions (default true). */
  tools?: boolean;
  /** Test seam: run one fresh turn without a real Muse host. */
  runTurn?: (prompt: string, onItem: (item: TurnItem) => void) => Promise<TurnItem[]>;
  /** Test seam: compactor calls without a real Muse host. */
  ask?: Ask;
}

export interface AskResult {
  /** The turn's reply text (last talk item), or "" when the turn said nothing. */
  reply: string;
  /** Every item the turn logged, in order. */
  items: TurnItem[];
}

export class OptChat {
  readonly memory: Memory;
  readonly store: string;
  private readonly lock: ChatLock;
  private mcp: OptChatMcpServer | undefined;
  private closed = false;

  private readonly options: OptChatOptions;
  private constructor(store: string, lock: ChatLock, memory: Memory, options: OptChatOptions) {
    this.store = store;
    this.lock = lock;
    this.memory = memory;
    this.options = options;
  }

  /** One MSP host owns one native session, so every call gets a fresh host. */
  private newHost(readOnly = false): Promise<MuseHost> {
    return createMuseHost({
      ...(this.options.binaryPath ? { binaryPath: this.options.binaryPath } : {}),
      cwd: this.options.cwd,
      readOnly,
    });
  }

  /** Open (or create) the chat for a working directory, taking its writer lock. */
  static async open(options: OptChatOptions): Promise<OptChat> {
    const store = options.store ?? storeFor(options.cwd);
    const lock = acquireLock(store);
    const previous = process.env[STORE_ENV];
    process.env[STORE_ENV] = store;
    try {
      const ask: Ask =
        options.ask ??
        (async (prompt, signal) => {
          const host = await createMuseHost({
            ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
            cwd: options.cwd,
            readOnly: true,
          });
          try {
            return await makeCompactorAsk(
              host,
              options.cwd,
              options.compactorModelId ?? options.modelId,
            )(prompt, signal);
          } finally {
            await host.close();
          }
        });
      const system = options.instructions ? `${SYSTEM}\n\n${options.instructions}` : SYSTEM;
      const memory = new Memory(store, { writable: true, ask, system });
      const chat = new OptChat(store, lock, memory, options);
      if (options.tools !== false) chat.mcp = await serveOptChatTools(memory);
      memory.pump();
      return chat;
    } catch (error) {
      lock.release();
      if (previous === undefined) delete process.env[STORE_ENV];
      else process.env[STORE_ENV] = previous;
      throw error;
    }
  }

  private system(): string {
    return this.options.instructions ? `${SYSTEM}\n\n${this.options.instructions}` : SYSTEM;
  }

  /**
   * One user message (§6): wait for the chat before it to be summarized,
   * render the view, run a fresh session, log everything as it happens.
   */
  async ask(text: string, signal?: AbortSignal): Promise<AskResult> {
    if (this.closed) throw new Error("optchat is closed");
    await this.memory.settle(signal);
    const view = this.memory.render();
    const [message] = this.memory.log("user", `(in ${this.options.cwd}) ${text}`);
    const prompt = `${this.system()}\n\n${view}\n\n${text}`;
    const logItem = (item: TurnItem) => {
      const kind: Kind = item.kind;
      this.memory.log(kind, kind === "echo" || kind === "tool" ? capText(item.text) : item.text);
    };
    let items: TurnItem[];
    if (this.options.runTurn) {
      items = await this.options.runTurn(prompt, logItem);
    } else {
      const host = await this.newHost();
      try {
        const config =
          this.mcp && host.grantedCapabilities.includes("sessionMcp")
            ? { mcpServers: { optchat: this.mcp.config } }
            : undefined;
        let logged = 0;
        items = await runFreshTurn(host, {
          workspaceRoot: this.options.cwd,
          prompt,
          ...(this.options.modelId ? { modelId: this.options.modelId } : {}),
          ...(config ? { config } : {}),
          ...(signal ? { signal } : {}),
          onItem: (item) => {
            logged++;
            logItem(item);
          },
        });
        // Items that completed without an onItem call are still logged once.
        for (const item of items.slice(logged)) logItem(item);
      } finally {
        await host.close();
      }
    }
    void message;
    return { reply: items.filter((item) => item.kind === "talk").at(-1)?.text ?? "", items };
  }

  /** A subagent's final reply enters the chat as one `work` message (§6). */
  logWork(agentName: string, report: string): void {
    this.memory.log("work", `[${agentName}] ${report}`);
  }

  zoom(id: number, n: number): string {
    return this.memory.zoom(id, n);
  }
  date(id: number): string {
    return this.memory.date(id);
  }
  view(): string {
    return this.memory.render();
  }
  /** Wait until every view line is a summary (true) or a needed node failed. */
  settle(signal?: AbortSignal): Promise<boolean> {
    return this.memory.settle(signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.memory.close();
    await this.mcp?.close();
    this.lock.release();
  }
}

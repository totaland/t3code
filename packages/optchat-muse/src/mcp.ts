// @effect-diagnostics nodeBuiltinImport:off -- plain Node HTTP MCP server; no Effect services.
// zoom/date as MCP tools over streamable HTTP, in the shape Muse's
// session/start config accepts (see provider-muse adapter: mode
// "optional", transport "streamableHttp"). Minimal JSON-RPC: initialize,
// ping, tools/list, tools/call. The Memory is only ever read here.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Memory } from "./memory.ts";
import { DATE_DESCRIPTION, ZOOM_DESCRIPTION } from "./prompts.ts";

export interface OptChatTools {
  zoom(args: { id: number; n: number }): string;
  date(args: { id: number }): string;
}

/** The zoom/date tool handlers bound to a chat (§6). Usable without HTTP in tests. */
export function createOptChatTools(memory: Memory): OptChatTools {
  return {
    zoom: ({ id, n }) => memory.zoom(id, n),
    date: ({ id }) => memory.date(id),
  };
}

const TOOLS = [
  {
    name: "zoom",
    description: ZOOM_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" }, n: { type: "integer" } },
      required: ["id", "n"],
    },
  },
  {
    name: "date",
    description: DATE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
  },
] as const;

export interface OptChatMcpServer {
  /** Value for session/start `config.mcpServers["optchat"]`. */
  readonly config: {
    transport: "streamableHttp";
    mode: "optional";
    url: string;
    headers: { Authorization: string };
  };
  close(): Promise<void>;
}

/** Async zoom/date handlers, for chats owned by another process (e.g. the Pi hub). */
export interface OptChatToolHandlers {
  zoom(args: { id: number; n: number }): Promise<string> | string;
  date(args: { id: number }): Promise<string> | string;
}

/** Serve zoom/date for one chat on a loopback port, bearer-token guarded. */
export async function serveOptChatTools(memory: Memory): Promise<OptChatMcpServer> {
  return serveOptChatToolHandlers(createOptChatTools(memory));
}

/** Serve zoom/date from arbitrary handlers on a loopback port, bearer-token guarded. */
export async function serveOptChatToolHandlers(
  tools: OptChatToolHandlers,
): Promise<OptChatMcpServer> {
  const token = randomBytes(24).toString("base64url");
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", async () => {
      let rpc: { id?: unknown; method?: string; params?: Record<string, unknown> };
      try {
        rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof rpc;
      } catch {
        res.writeHead(400).end();
        return;
      }
      const reply = (result: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }));
      };
      switch (rpc.method) {
        case "notifications/initialized":
        case "notifications/cancelled":
          res.writeHead(202).end();
          return;
        case "initialize":
          return reply({
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "optchat-muse", version: "0.1.0" },
          });
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: TOOLS });
        case "tools/call": {
          const name = String(rpc.params?.["name"] ?? "");
          const args = (rpc.params?.["arguments"] ?? {}) as Record<string, unknown>;
          const num = (value: unknown) => (typeof value === "number" ? value : Number(value));
          const text =
            name === "zoom"
              ? await tools.zoom({ id: num(args["id"]), n: num(args["n"]) })
              : name === "date"
                ? await tools.date({ id: num(args["id"]) })
                : `Unknown tool ${name}.`;
          return reply({
            content: [{ type: "text", text }],
            isError: name !== "zoom" && name !== "date",
          });
        }
        default: {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id ?? null,
              error: { code: -32601, message: `method not found: ${rpc.method}` },
            }),
          );
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("optchat MCP server has no port");
  return {
    config: {
      transport: "streamableHttp",
      mode: "optional",
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { Authorization: `Bearer ${token}` },
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

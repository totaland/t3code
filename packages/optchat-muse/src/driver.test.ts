// @effect-diagnostics nodeBuiltinImport:off -- plain Node temp dirs in tests.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { OptChat } from "./driver.ts";
import { createOptChatTools } from "./mcp.ts";
import { classifyItem, classifyItems } from "./muse.ts";
import type { Ask } from "./memory.ts";
import type { TurnItem } from "./muse.ts";

const dirs: string[] = [];
function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "optchat-driver-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fakeAsk: Ask = async (prompt) => `sum: ${prompt.slice(0, 30).replace(/\s+/g, " ")}`;

function fakeRunner(replies: TurnItem[][]) {
  let at = 0;
  const prompts: string[] = [];
  return {
    prompts,
    runTurn: async (prompt: string, onItem: (item: TurnItem) => void) => {
      prompts.push(prompt);
      const items = replies[at++] ?? [];
      for (const item of items) onItem(item);
      return items;
    },
  };
}

describe("OptChat driver (SPEC §6)", () => {
  test("each ask is a fresh call whose prompt is system + view + message", async () => {
    const runner = fakeRunner([
      [{ kind: "talk", text: "first answer" }],
      [{ kind: "talk", text: "second answer" }],
    ]);
    const chat = await OptChat.open({
      cwd: "/tmp",
      store: tempStore(),
      tools: false,
      ask: fakeAsk,
      runTurn: runner.runTurn,
    });
    const one = await chat.ask("what is the plan?");
    expect(one.reply).toBe("first answer");
    const two = await chat.ask("and then?");
    expect(two.reply).toBe("second answer");
    expect(runner.prompts[0]).toContain("what is the plan?");
    expect(runner.prompts[1]).toContain("<chat>");
    expect(runner.prompts[1]).toContain("first answer");
    expect(chat.memory.messages.map((m) => m.kind)).toEqual(["user", "talk", "user", "talk"]);
    await chat.close();
  });

  test("subagent reports land as work messages; zoom/date tools read the chat", async () => {
    const runner = fakeRunner([[{ kind: "talk", text: "done" }]]);
    const chat = await OptChat.open({
      cwd: "/tmp",
      store: tempStore(),
      tools: false,
      ask: fakeAsk,
      runTurn: runner.runTurn,
    });
    await chat.ask("go");
    chat.logWork("Scout", "found 3 files");
    expect(chat.memory.messages.at(-1)?.kind).toBe("work");
    expect(chat.memory.messages.at(-1)?.text).toContain("[Scout]");
    const tools = createOptChatTools(chat.memory);
    expect(tools.zoom({ id: 0, n: 1 })).toContain("user:");
    expect(tools.date({ id: 0 })).toMatch(/\d{4}/);
    await chat.close();
  });

  test("a second writer is refused while the lock is held", async () => {
    const store = tempStore();
    const first = await OptChat.open({
      cwd: "/tmp",
      store,
      tools: false,
      ask: fakeAsk,
      runTurn: fakeRunner([]).runTurn,
    });
    await expect(
      OptChat.open({
        cwd: "/tmp",
        store,
        tools: false,
        ask: fakeAsk,
        runTurn: fakeRunner([]).runTurn,
      }),
    ).rejects.toThrow(/one writer/);
    await first.close();
    const second = await OptChat.open({
      cwd: "/tmp",
      store,
      tools: false,
      ask: fakeAsk,
      runTurn: fakeRunner([]).runTurn,
    });
    await second.close();
  });

  test("thought items are never logged (§1)", () => {
    expect(
      classifyItem({ itemId: "1", kind: "reasoning", revision: 1, text: "secret" }),
    ).toBeUndefined();
    expect(
      classifyItem({ itemId: "2", kind: "agentMessage", revision: 1, text: "hello" })?.kind,
    ).toBe("talk");
    expect(
      classifyItem({ itemId: "3", kind: "toolCall", revision: 1, toolName: "bash" })?.kind,
    ).toBe("tool");
    expect(classifyItem({ itemId: "4", kind: "toolResult", revision: 1, text: "out" })?.kind).toBe(
      "echo",
    );
    expect(
      classifyItem({ itemId: "5", kind: "subagentReport", revision: 1, text: "report" })?.kind,
    ).toBe("work");
  });

  test("the MSP copy of the user message and reminder children are never logged", () => {
    // A fresh turn echoes the whole prompt back as a userMessage item; the
    // driver already logged the user's own words (§6).
    expect(
      classifyItem({ itemId: "1", kind: "userMessage", revision: 1, text: "whole prompt" }),
    ).toBeUndefined();
    expect(
      classifyItem({
        itemId: "2",
        kind: "reminderChild",
        revision: 1,
        text: "Reminder child session",
      }),
    ).toBeUndefined();
  });

  test("a completed toolCall expands to its call and its result", () => {
    expect(
      classifyItems({
        itemId: "1",
        kind: "toolCall",
        revision: 3,
        tool: "bash",
        args: '{"command":"echo hi"}',
        visibleOutput: "hi\n",
      }),
    ).toEqual([
      { kind: "tool", text: 'bash {"command":"echo hi"}' },
      { kind: "echo", text: "hi\n" },
    ]);
  });
});

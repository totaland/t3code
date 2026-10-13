// @effect-diagnostics nodeBuiltinImport:off -- plain Node temp dirs in tests.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { Memory, bytes, mostDue, type Ask } from "./memory.ts";

const dirs: string[] = [];
function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "optchat-muse-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Deterministic fake compactor: first 40 chars of the input block. */
const fakeAsk: Ask = async (prompt) => {
  const input =
    prompt.split("<input>")[1]?.split("</input>")[0]?.trim().replace(/\s+/g, " ") ?? prompt;
  return `sum: ${input.slice(0, 40)}`;
};

const long = (seed: string) => `${seed} ${"detail ".repeat(120)}`;

describe("Memory (SPEC §1-§4)", () => {
  test("short messages are their own nodes; the view renders id+n lines", () => {
    const memory = new Memory(tempStore(), { writable: true, ask: fakeAsk });
    memory.log("user", "hello there");
    memory.log("talk", "hi");
    expect(memory.total).toBe(2);
    expect(memory.render()).toContain("0+1|user: hello there");
    expect(memory.render()).toContain("1+1|talk: hi");
    expect(memory.pending).toBe(0);
    memory.close();
  });

  test("long messages are compacted by the model and settle", async () => {
    const memory = new Memory(tempStore(), { writable: true, ask: fakeAsk });
    memory.log("user", long("first"));
    memory.log("talk", long("second"));
    await expect(memory.settle()).resolves.toBe(true);
    expect(memory.pending).toBe(0);
    expect(memory.render()).toContain("sum:");
    memory.close();
  });

  test("zoom opens pairs down to the whole message; date resolves", async () => {
    const memory = new Memory(tempStore(), { writable: true, ask: fakeAsk });
    for (let i = 0; i < 4; i++) memory.log("user", long(`msg${i}`));
    await memory.settle();
    const opened = memory.zoom(0, 4);
    expect(opened).toContain("0+2|");
    expect(opened).toContain("2+2|");
    expect(memory.zoom(2, 1)).toContain("msg2");
    expect(memory.zoom(3, 2)).toContain("No line");
    expect(memory.date(1)).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(memory.date(99)).toBe("No message 99.");
    memory.close();
  });

  test("the saved view and tree survive a reopen without rebuilding nodes", async () => {
    const store = tempStore();
    const first = new Memory(store, { writable: true, ask: fakeAsk });
    first.log("user", long("persist me"));
    await first.settle();
    const callsBefore = first.calls;
    first.close();
    const second = new Memory(store, { writable: true, ask: fakeAsk });
    expect(second.total).toBe(1);
    expect(second.render()).toContain("sum:");
    expect(second.calls).toBeLessThanOrEqual(callsBefore);
    second.close();
  });

  test("read-only memory refuses to log", () => {
    const memory = new Memory(tempStore(), { writable: false });
    expect(() => memory.log("user", "x")).toThrow(/read-only/);
    memory.close();
  });

  test("mostDue measures age from the pair's LAST message (§3.2)", () => {
    // View 0+4, 4+4, 8+1, 9+1 at T=10: push merges 8-9, never 0-7.
    const parts = [
      { l: 2, i: 0 },
      { l: 2, i: 1 },
      { l: 0, i: 8 },
      { l: 0, i: 9 },
    ];
    const built = () => true;
    expect(mostDue(parts, 10, built)).toBe(2);
    expect(bytes("é")).toBe(2);
  });
});

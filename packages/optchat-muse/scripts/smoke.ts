// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- standalone smoke script.
// Real-host smoke: two fresh Muse sessions prove the view is the only
// continuity. Run: pnpm --filter @t3tools/optchat-muse smoke
// Requires a logged-in `muse` binary on PATH (or MUSE_BIN).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OptChat } from "../src/server.ts";

const workspace = mkdtempSync(join(tmpdir(), "optchat-smoke-ws-"));
const store = mkdtempSync(join(tmpdir(), "optchat-smoke-store-"));
const chat = await OptChat.open({
  cwd: workspace,
  store,
  ...(process.env["MUSE_BIN"] ? { binaryPath: process.env["MUSE_BIN"] } : {}),
});
try {
  const first = await chat.ask("Remember this codeword: BANANA-42. Reply with exactly: noted");
  console.log("turn 1 reply:", JSON.stringify(first.reply.slice(0, 120)));
  const second = await chat.ask(
    "What codeword did I ask you to remember? Reply with only the codeword.",
  );
  console.log("turn 2 reply:", JSON.stringify(second.reply.slice(0, 120)));
  console.log("view:\n" + chat.view());
  const ok = second.reply.includes("BANANA-42");
  console.log(
    ok
      ? "SMOKE PASS: second fresh session recalled the codeword from the view"
      : "SMOKE FAIL: codeword not recalled",
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  await chat.close();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
}

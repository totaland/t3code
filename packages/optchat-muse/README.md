# @t3tools/optchat-muse

OptChat (UniiChat) for Muse: one endless chat per project, following
[SPEC.md](SPEC.md) (Victor Taelin's gist, copied verbatim). The sibling Pi
implementation lives in `dotfiles/pi-packages/pi-optchat-gist`; this package
is the same design driven over the Muse MSP SDK (`@muse-code/sdk`,
`muse serve`), in the style of `packages/provider-muse`.

## How it works

- **One chat per project.** The store is resolved from the working
  directory's main git repository (`~/.local/share/optchat-muse/projects/`,
  override with `OPTCHAT_MUSE_HOME`; subagents inherit via
  `OPTCHAT_MUSE_STORE`). This store is separate from Pi's — one writer per
  chat (SPEC mistake #12), enforced by a pid lock.
- **Fresh session per message.** Each `ask()` waits for the chat to be
  summarized, renders the saved 64–128 KB sawtooth view, logs the user
  message, then runs ONE turn in a brand-new native Muse session whose
  prompt is `[system] + [view] + [message]`. Nothing carries over but the
  view. Replies, tool calls/results are logged as they complete; thoughts
  are never logged; tool output is clipped to 30K chars; subagent reports
  land as `work` messages.
- **Compactions** run in fresh read-only sessions (`denyUnmatched`), ≤8 at
  a time, each node at most 512 bytes with the ruler/shrink-retry loop.
- **zoom/date** are served to turn sessions as MCP tools (streamable HTTP,
  optional mode) when the host grants `sessionMcp`; also usable directly
  via `chat.zoom()` / `chat.date()` / `createOptChatTools()`.

## Usage

```ts
import { OptChat } from "@t3tools/optchat-muse/server";

const chat = await OptChat.open({ cwd: process.cwd() });
const { reply } = await chat.ask("what did we decide about the API?");
await chat.close();
```

## Verify

```bash
pnpm --filter @t3tools/optchat-muse test       # fake-model suite
pnpm --filter @t3tools/optchat-muse typecheck
pnpm --filter @t3tools/optchat-muse smoke      # real muse host, 2 fresh sessions
```

## Known limits (v0.1)

- Turn items are classified from MSP `item/completed` notifications
  (message → `talk`, tool → `tool`/`echo`, subagent/workflow → `work`);
  exotic item kinds are skipped rather than mislogged.
- One driver process at a time (no multi-window socket hub like Pi's);
  parallel windows need the follow-up hub port.
- Approvals inside a turn surface as Muse's own `promptUnmatched` flow on
  the MSP connection; embedding hosts that need custom approval UX should
  pass their own runner via `OptChatOptions.runTurn`.

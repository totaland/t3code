# T3 Code

T3 Code is a minimal web GUI for coding agents (currently Codex, Claude, Cursor, and OpenCode, more coming soon).

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, and OpenCode.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `cursor-agent login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Run without installing

```bash
npx t3@latest
```

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

There's no public docs site yet, checkout the miscellaneous markdown files in [docs](./docs).

## Local microphone voice bridge

T3 Code can proxy microphone audio to the loopback-only `backend-voice` model
gateway. The browser records a push-to-talk WAV, T3 sends the transcript as the
current agent turn, then synthesizes and queues completed sentences while the
reply streams. Any final incomplete sentence is spoken when the message
completes. T3 proxies the gateway's PCM16 body as a real-time stream, and the
browser schedules small PCM buffers on one audio timeline so playback starts
before synthesis finishes. The composer selector exposes `Auto`, `Qwen3-TTS`,
`Kokoro`, and `Step-Audio-EditX`; Step uses the trusted server-side James
reference, remains full-buffer at the model layer, and never accepts an
arbitrary client voice path.

Configure the T3 server, not the browser:

```dotenv
T3CODE_MODEL_GATEWAY_URL="http://127.0.0.1:8091"
T3CODE_MODEL_GATEWAY_API_KEY="the same value as backend-voice MODEL_GATEWAY_API_KEY"
```

Remote/mobile microphone access requires a secure browser context. Use HTTPS
(for example Tailscale Serve) rather than plain Tailnet HTTP. The API key stays
server-side, and the voice proxy routes require an authenticated T3 session
with environment operate scope.

## Documentation

- [Getting started](./docs/getting-started/quick-start.md)
- [Remote access](./docs/user/remote-access.md)
- [Keeping T3 Code in sync](./docs/user/server-updates.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Provider guides](./docs/providers/codex.md)
- [Operations](./docs/operations/ci.md)
- [Reference](./docs/reference/encyclopedia.md)

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).

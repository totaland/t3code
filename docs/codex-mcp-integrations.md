# Codex MCP Integrations

T3 Code can pass Codex MCP server definitions into each Codex app-server thread through
`providers.codex.mcpServers` in server settings.

The settings shape mirrors Codex `config.toml` MCP server entries, but uses camelCase in
T3 settings:

```json
{
  "providers": {
    "codex": {
      "mcpServers": {
        "axonMemory": {
          "enabled": true,
          "command": "uv",
          "args": [
            "run",
            "--project",
            "/Users/james/git/mcp/cool-shit/coding-ai/memory/agent-new",
            "--no-sync",
            "python",
            "examples/serve_memory_mcp.py"
          ],
          "cwd": "/Users/james/git/mcp/cool-shit/coding-ai/memory/agent-new",
          "startupTimeoutMs": 20000,
          "defaultToolsApprovalMode": "prompt"
        },
        "codeIntel": {
          "enabled": true,
          "command": "uv",
          "args": [
            "run",
            "--project",
            "/Users/james/git/mcp/cool-shit/coding-ai/code-graph-rag/code-intel/code-intel",
            "--no-sync",
            "code-intel",
            "--root",
            "${cwd}",
            "serve"
          ],
          "startupTimeoutMs": 20000,
          "defaultToolsApprovalMode": "prompt"
        }
      }
    }
  }
}
```

Supported placeholders in `args`, `cwd`, and `env` values:

- `${cwd}` / `{cwd}`: the Codex thread working directory
- `${workspaceRoot}` / `{workspaceRoot}`: alias for the Codex thread working directory

Notes:

- The Axon memory example runs the stdio MCP server from `examples/serve_memory_mcp.py`.
- The code-intel example runs one MCP server per Codex session, rooted at that session's `cwd`.
- These entries are injected as Codex session config, not written into the user's
  `CODEX_HOME/config.toml`.
- Local service dependencies still apply. The current code-intel CLI expects FalkorDB unless
  configured otherwise, and the Axon memory YAML points at FalkorDB on `127.0.0.1:6380`.

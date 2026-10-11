# Connecting an MCP client

Four clients, one server. Every entry here starts the same binary over stdio; what differs is
the file each client reads and the key it expects.

| Client         | File                                                  | Key          |
| -------------- | ----------------------------------------------------- | ------------ |
| Claude Desktop | `claude_desktop_config.json` (see the comment inside) | `mcpServers` |
| Claude Code    | `claude mcp add …`, no file to edit                   | —            |
| Cursor         | `.cursor/mcp.json` or `~/.cursor/mcp.json`            | `mcpServers` |
| VS Code        | `.vscode/mcp.json`                                    | `servers`    |

## Three things that are true for all of them

**Use an absolute path for `--config`.** The server is started with an unspecified working
directory, so a relative path resolves somewhere you did not intend. Paths _inside_ the
configuration file are resolved relative to that file, so only this one has to be absolute.

**Secrets stay in the environment.** The configuration references them (`{ env: MQTT_PASSWORD }`)
and never contains them, so the file can be committed. VS Code can prompt for the value once
per session; the others read it from the `env` block of the entry.

**Read stderr when it fails.** The server writes everything there, protocol frames excepted,
which is where every one of these clients collects a server's output. A server that exits
before answering has said why.

## Claude Code

```bash
claude mcp add mqtt-intelligence -- npx -y @kadeya/mqtt-intel-mcp --config /absolute/path/to/mqtt-intelligence.yaml
```

Add `--scope project` to write it into the repository's `.mcp.json` for everyone, or
`--scope user` to have it in every project. `claude mcp list` then shows whether it connects.

## Before the package is published

`@kadeya/mqtt-intel-mcp` is not on npm yet, so `npx` cannot fetch it. Until it is, build this
repository and point the client at the result:

```json
{
  "mcpServers": {
    "mqtt-intelligence": {
      "command": "node",
      "args": [
        "/absolute/path/to/mqtt-intelligence-mcp/packages/mcp-server/dist/cli/bin.js",
        "--config",
        "/absolute/path/to/mqtt-intelligence-mcp/examples/industrial-machine/mqtt-intelligence.yaml"
      ]
    }
  }
}
```

`npm install && npm run build` first. The same two arguments work in every client above.

## Checking it before you wire it up

Point the CLI at the same file:

```bash
npx @kadeya/mqtt-intel-mcp check --config /absolute/path/to/mqtt-intelligence.yaml
```

It validates the file, connects every broker, subscribes the discovery filters and exits 0
only if all of them worked. A client that then fails to start the server has a different
problem, and one you can look for in its logs rather than in your broker.

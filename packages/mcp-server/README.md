# @kadeya/mqtt-intel-mcp

**Give AI agents safe, structured and observable access to MQTT infrastructures.**

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI agent
explore and understand an MQTT namespace: which topics exist, what is published on them, what
the payloads look like, what changed around an incident.

It is **read-only** — there is no publish path at all — works with any standard MQTT broker,
and tells the agent **what it could not observe** so the agent does not invent the rest.

```bash
npx @kadeya/mqtt-intel-mcp check --config ./mqtt-intelligence.yaml
```

Then point an MCP client at the same file:

```json
{
  "mcpServers": {
    "mqtt-intelligence": {
      "command": "npx",
      "args": ["-y", "@kadeya/mqtt-intel-mcp", "--config", "/absolute/path/to/config.yaml"]
    }
  }
}
```

## The six tools

`mqtt_list_brokers` · `mqtt_discover_topics` · `mqtt_topic_tree` · `mqtt_search_topics` ·
`mqtt_describe_topic` · `mqtt_get_recent_messages`

Every answer separates what was **observed** from what was **computed**, says what the server
could see, and states what it cannot tell you. "Not observed" never means "does not exist".

## Commands

| Command | Does                                                                  |
| ------- | --------------------------------------------------------------------- |
| `serve` | Serves MCP over stdio. The default, with no arguments                 |
| `check` | Validates the configuration and tests every broker before you wire it |

Exit codes: `0` success, `1` unexpected, `2` bad command line, `3` bad configuration,
`4` a broker failed. Everything the CLI writes goes to **stderr**, including `--help`, because
stdout carries MCP protocol frames and nothing else.

## Documentation

Full documentation, the configuration reference, the security model and a runnable example
stack are in the repository:
**[github.com/kadeyaorg/mqtt-intelligence-mcp](https://github.com/kadeyaorg/mqtt-intelligence-mcp)**

The engine behind it is published separately as
[`@kadeya/mqtt-intel-core`](https://www.npmjs.com/package/@kadeya/mqtt-intel-core), with no MCP
dependency.

Apache-2.0 · Node.js 22 (≥ 22.12), 24 or 26

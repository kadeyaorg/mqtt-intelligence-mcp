---
'@kadeya/mqtt-intel-core': minor
'@kadeya/mqtt-intel-mcp': minor
---

First release.

An MCP server, and a Node.js library, giving an AI agent read-only, structured and observable
access to MQTT brokers.

- Six read-only MCP tools: list brokers, discover topics, topic tree, search, describe a
  topic, recent messages. No publish path exists.
- Multi-broker: MQTT 3.1.1 and 5, TLS and mutual TLS, WebSockets, independent connections
  with their own credentials, policy and reconnection.
- Passive discovery with a bounded topic catalogue, per-topic statistics, and explicit
  observation coverage: every answer says what the server could not see.
- Payload classification and safe views: JSON, text, number, boolean and binary, truncated,
  escaped and redacted before an agent sees them.
- A read policy where deny beats allow, applied at ingest: a denied topic is never stored,
  counted or listed.
- A `mqtt-intel-mcp` command: `serve` over stdio, and `check` to validate a configuration and
  test every broker before wiring it to an agent.

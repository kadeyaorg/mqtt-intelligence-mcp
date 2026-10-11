# Logs and metrics

## Logs go to stderr. All of them.

In stdio mode stdout carries MCP protocol frames, so every log line, the `check` report,
`--help` and `--version` go to stderr. That is also where every MCP client collects a server's
output, which makes stderr the right place to look when a server fails to start
([ADR-0018](adr/0018-cli-contract.md)).

`console` is banned outright by the lint configuration. Logging goes through the `Logger` port.

### Format

`logging.format: json` (the default) writes one JSON object per line:

```json
{
  "time": "2026-10-11T07:04:12.340Z",
  "level": "info",
  "message": "Tool call",
  "component": "mcp",
  "tool": "mqtt_search_topics",
  "broker": "factory-fr",
  "durationMs": 7,
  "outcome": "ok"
}
```

`logging.format: pretty` writes a line a human reads, for a terminal:

```
07:04:12.340 INFO  Tool call component=mcp tool=mqtt_search_topics durationMs=7 outcome=ok
```

Levels: `trace`, `debug`, `info` (default), `warn`, `error`. `debug` adds subscription and
reconnection detail and is the first thing to turn on when a broker behaves oddly.

### What is always true of a log line

- **No secret, ever.** Values of known secret-shaped fields are replaced, `Secret` objects
  print as `[REDACTED]`, and credentials inside a URL or an `Authorization` header are masked.
- **Bounded.** Lines are truncated at a maximum length; a payload never ends up in a log.
- **It cannot throw.** A field whose getter throws degrades the line to a `loggingError`
  rather than taking down the ingest path with it.

### The audit line

Every tool call produces one:

| Field           | Meaning                                              |
| --------------- | ---------------------------------------------------- |
| `component`     | `mcp`                                                |
| `tool`          | The tool name                                        |
| `durationMs`    | How long the call took                               |
| `outcome`       | `ok`, or the error code                              |
| `correlationId` | On `INTERNAL` only: matches what the agent was given |

Arguments are sanitized before they are logged. A tool that failed unexpectedly logs the
detail here and returns only the correlation id to the agent, so the two can be matched
without the agent ever seeing what went wrong.

## Metrics

A `MetricsRecorder` port, **no-op by default**: no metrics dependency is imposed on anyone who
does not want one. An OpenTelemetry bridge is planned as a separate package (V0.4), which is
why the names already follow a namespace that will not collide with future OTel MQTT semantic
conventions ([ADR-0015](adr/0015-observability-ports.md)).

| Metric                                      | Type            | Attributes      |
| ------------------------------------------- | --------------- | --------------- |
| `mqtt_intelligence.messages.received`       | counter         | broker          |
| `mqtt_intelligence.messages.bytes`          | counter         | broker          |
| `mqtt_intelligence.messages.denied`         | counter         | broker          |
| `mqtt_intelligence.payloads.dropped`        | counter         | broker, reason  |
| `mqtt_intelligence.topics.tracked`          | up-down counter | broker          |
| `mqtt_intelligence.topics.evicted`          | counter         | broker          |
| `mqtt_intelligence.broker.connections`      | up-down counter | broker, state   |
| `mqtt_intelligence.broker.reconnections`    | counter         | broker          |
| `mqtt_intelligence.broker.connect.duration` | histogram       | broker, outcome |
| `mqtt_intelligence.subscriptions.active`    | up-down counter | broker          |
| `mqtt_intelligence.subscriptions.rejected`  | counter         | broker, reason  |
| `mqtt_intelligence.ingest.flush.duration`   | histogram       | broker          |
| `mqtt_intelligence.tool.calls`              | counter         | tool, outcome   |

Supplying a recorder is one object:

```ts
import { createEngine } from '@kadeya/mqtt-intel-core';

const engine = createEngine(config, { metrics: myRecorder });
```

`@kadeya/mqtt-intel-core/testing` ships `InMemoryMetricsRecorder`, which is what the suite
asserts against.

## Degradation is a number, not a silence

Whatever the server drops, it counts, and the count reaches the agent in every answer's
coverage rather than only an operator's dashboard:

| Field             | Means                                              |
| ----------------- | -------------------------------------------------- |
| `droppedPayloads` | Payloads not inspected, under a budget             |
| `deniedMessages`  | Messages the read policy refused                   |
| `evictedTopics`   | Topics dropped at the catalogue limit              |
| `ignoredTopics`   | Topics not admitted at the catalogue limit         |
| `gaps`            | Periods with no connection, with their reason      |
| `rejectedFilters` | Discovery filters the policy or the broker refused |

A server under pressure says so in the answer. That is the difference between a short answer
and a wrong one ([ADR-0009](adr/0009-bounded-ingestion.md)).

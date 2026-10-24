# Architecture

An orientation. The reasoning behind each decision is in the
[ADRs](adr/README.md); the full design document, with the data model, the lifecycles and the
boundaries, is the [architecture proposal](proposal/03-architecture.md).

```text
AI agent (MCP client)
        │  stdio, JSON-RPC
   @kadeya/mqtt-intel-mcp      MCP tools · schemas · rendering · CLI
        │  Engine
   @kadeya/mqtt-intel-core     policy · discovery · ingest · catalogue · payloads
        │  ports
   MQTT brokers                via mqtt.js, behind a transport port
```

## Two packages, one of them not about MCP at all

`@kadeya/mqtt-intel-core` is a plain TypeScript library. It has **no MCP dependency**, and a
lint rule enforces that. MCP is one adapter over it; a CLI, an HTTP service or an embedding in
someone else's program are others, and none of them would need the engine to change
([ADR-0003](adr/0003-core-independent-from-mcp.md)).

The adapter is deliberately thin: it validates, clamps, calls the engine, renders and maps
errors. **It makes no security decision of its own.** Those all live in the engine, so they
hold whatever is driving it ([ADR-0002](adr/0002-monorepo-with-two-packages.md)).

## Ports, and what sits behind them

Everything the engine cannot control is a port with a fake beside it:

| Port              | Default              | Why it is a port                               |
| ----------------- | -------------------- | ---------------------------------------------- |
| `MqttTransport`   | mqtt.js              | mqtt.js has sharp edges; they stay in one file |
| `TopicCatalog`    | in-memory, bounded   | SQLite and Postgres are planned, same contract |
| `MessageStore`    | in-memory, bounded   | idem                                           |
| `Clock`           | system               | tests advance time instead of waiting for it   |
| `Logger`          | JSON lines on stderr | stdout is the protocol                         |
| `MetricsRecorder` | no-op                | no observability dependency is imposed         |

`mqtt` may be imported in exactly one directory, and a lint rule says so
([ADR-0006](adr/0006-mqttjs-behind-transport-port.md)). The reason is not purity: mqtt.js
rejects a whole subscription batch when the broker refuses one filter, can leave a connect
promise unsettled forever, and starves its own keepalive if a message handler blocks. Each of
those is handled once, where it belongs.

The storage ports ship with a **contract test suite** in `@kadeya/mqtt-intel-core/testing`, so
a future SQLite store proves it behaves like the in-memory one rather than hoping it does
([ADR-0008](adr/0008-storage-ports.md)).

## Inside the core

Modules with an enforced dependency table — a local ESLint rule checks it, and a module
missing from the table cannot import anything at all, so adding one is a reviewed change.

```
domain      topics, errors, ids, clock, secrets, QoS        (depends on nothing)
config      schema, resolution, secret references
payload     classification, JSON bounding, safe views
policy      the read policy: deny beats allow
observability  logger and metrics ports
transport   the MQTT port, and mqtt.js behind it
catalog     topic records, mergeable statistics
store       message store port, in-memory implementations
broker      connection state machine, registry
subscription  leases, minimal covering set
ingest      the bounded pipeline
discovery   subscriptions and observation coverage
query       tree, search, describe, recent messages, the answer envelope
engine.ts   the composition root
```

## Three ideas that shape everything else

### Count everything, inspect a sample, store a bounded window

A broker can deliver more than any process can parse. So `accept()` is O(1) and synchronous —
it runs inside the transport's message handler, and holding it holds the keepalive with it —
and the expensive work happens on a flush tick, under budgets. **Message counts stay exact**;
what is sampled, dropped or truncated is counted and reported in every answer
([ADR-0009](adr/0009-bounded-ingestion.md)).

### A minimal covering set of subscriptions

Subscriptions are leased. Before they reach the broker, overlapping filters are reduced to a
minimal covering set: `factory/#` and `factory/line-01/#` become one subscription. This is not
an optimisation. Without it a broker delivers the same message twice, and the integration
suite demonstrates exactly that when the reduction is disabled.

### Facts, observations, limitations

Every answer is an envelope: what was **observed**, what was **computed** and by which method,
what the server **could see**, and what the answer **cannot tell you**. The engine never
produces an inference — no cause, no intention, no business meaning — because a language model
will turn temporal proximity into causality if nothing stops it, and MQTT is full of traps that
invite exactly that ([ADR-0011](adr/0011-facts-observations-limitations.md)).

## Testing

| Suite                 | What it proves                                                     |
| --------------------- | ------------------------------------------------------------------ |
| Unit                  | Behaviour, against fakes and a controllable clock                  |
| Property (fast-check) | Invariants of topic matching and the read policy                   |
| Contract              | A storage adapter behaves like the reference one                   |
| Integration           | Real Mosquitto through Testcontainers: TLS, ACLs, reconnection     |
| Example stack         | The shipped example, through Docker Compose and the real binary    |
| Spawn                 | The CLI as a process: exit codes, stdout purity, graceful shutdown |

Every step of this project ended with a deliberate mutation: break the thing a test protects,
watch it go red, put it back. A test that passes either way buys confidence it has not earned.

## Where to read next

- [The MCP tools](mcp-tools.md)
- [Configuration](configuration.md)
- [Security and threat model](security.md)
- [Logs and metrics](observability.md)
- [Architecture proposal](proposal/README.md) — the full design document
- [ADRs](adr/README.md) — eighteen decisions, with the alternatives that were rejected

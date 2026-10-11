# MQTT Intelligence MCP

**Give AI agents safe, structured and observable access to MQTT infrastructures.**

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server, and a Node.js
library, that lets an AI agent explore and understand an MQTT namespace: which topics exist,
what is published on them, what the payloads look like, what changed around an incident. It is
**read-only**, works with **any standard MQTT broker**, and tells the agent **what it could not
observe** so the agent does not invent the rest.

> **Status: V0.1, not yet published to npm.** Everything on this page works today from a
> clone. The `@kadeya` npm organisation is not confirmed yet, so both packages are marked
> private and `npx @kadeya/mqtt-intel-mcp` does not resolve. [Releasing](docs/releasing.md)
> says what is left.

---

## Quick start

A broker, a fictional factory publishing to it, and an agent that can see both. Five minutes,
and nothing touches a real plant.

```bash
git clone https://github.com/kadeyaorg/mqtt-intelligence-mcp.git
cd mqtt-intelligence-mcp
npm install && npm run build
docker compose -f examples/industrial-machine/docker-compose.yml up -d --wait
node packages/mcp-server/dist/cli/bin.js check --config examples/industrial-machine/mqtt-intelligence.yaml
```

That last command prints `connection: ok`, `subscribed to factory/#`, and exits 0. Now point an
MCP client at the same file — in `claude_desktop_config.json`, `.cursor/mcp.json` or
`.vscode/mcp.json`, with **absolute paths**:

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

Claude Code needs no file:

```bash
claude mcp add mqtt-intelligence -- node /absolute/path/to/packages/mcp-server/dist/cli/bin.js --config /absolute/path/to/examples/industrial-machine/mqtt-intelligence.yaml
```

Then ask it something. Snippets for all four clients:
[examples/mcp-clients](examples/mcp-clients/README.md). Pointing it at a real broker:
[configuration](docs/configuration.md).

> Already running a broker on port 1883? The server will connect to **that** one. `check` will
> still print `connection: ok` — it reached a broker, just not yours — and the agent will then
> see no topics at all. The
> [example README](examples/industrial-machine/README.md#if-1883-is-taken) says how to move the
> port and the URL together.

## What you can do with it

Five things, all of which work today against the example stack — and against a real broker,
which is where they were worked out.

### Understand a namespace nobody documented

> _What MQTT topics exist on this broker? Show me the namespace as a tree._

MQTT has no index. Pointed at an unfamiliar broker, an agent comes back in thirty seconds with
the branches, how many topics are in each, how often they publish and what kind of payload they
carry. For a new engineer, an outside contractor, or you in six months on a different machine,
this is the win you feel first.

### Write code against a machine, without a terminal open beside you

> _Which topic carries the washer state, and what does its payload look like?_

```
plc/washer/state — 1 message every 1.5 s · retained · json
  {"Index":2,"Capacity":10,"HoodIsUp":true,"HoodIsDown":false,"State":"Filling"}
```

The real shape, the real rate, and the fact that it is a retained state topic. No
`mosquitto_sub` in another window, no copy-paste of a payload you hope is representative.

### Diagnose something that stopped

> _Something went wrong on line 01 a few minutes ago. What do you see?_

The agent gets both events with their receipt times — the robot error, and the washer going to
`HOLD` 1.2 seconds later. **It is not told that one caused the other**, because nothing an MQTT
client can observe says so. You get the gap and the facts; the conclusion stays yours. That
restraint is the whole point of the project, and the example stack is built to demonstrate it.

### See what has gone quiet

> _Which topics publish most often? Which have stopped?_

A node that crashed, a PLC that dropped off, a sensor that went silent — visible immediately.
And the other way round: the server knows what normal looks like for each topic (`1.40 msg/s`,
intervals between 152 and 263 ms), so "this one is publishing seven times slower than usual" is
a fact it can state rather than a feeling you have.

### Hand an agent broker access without holding your breath

There is **no publish path** — not disabled, absent. A read policy with deny precedence keeps
whole subtrees out of every answer, applied at ingest so no tool can reach them. You can point
this at a production broker and go and do something else.

## What it is not

- **Not a historian.** It sees what is published while it is watching, and the catalogue is in
  memory: restart it and it starts again. "What happened last Tuesday" is a question for your
  time-series database.
- **Not a schema tool yet.** It shows you the last payload; deriving a schema from many is V0.2.
- **Not a recorder yet.** Replaying a ten-minute window around an incident is V0.3.
- **Not a controller.** It cannot command anything, and when guarded publishing arrives in V0.4
  it will be off unless you turn it on.

## Why it exists

An engineer facing an unfamiliar broker subscribes to `#` and reads raw bytes, because MQTT
offers nothing better: no index, no schema, no description.

An AI agent handed a plain MQTT client has that problem and three of its own: it floods its
context with a firehose of messages, it can be led astray by payloads that read like
instructions, and it can publish to a topic that moves a real machine.

This gives the agent structure instead — a catalogue, statistics, safe payload views — and,
just as importantly, the limits of what was seen. The reasoning stays with the agent. The
engine only reports what it observed.

## What it does

| Capability                                                                  | Status |
| --------------------------------------------------------------------------- | ------ |
| Six read-only MCP tools, no publish path at all                             | V0.1   |
| Multi-broker: MQTT 3.1.1 and 5, TLS, mutual TLS, WebSockets                 | V0.1   |
| Passive discovery, bounded topic catalogue, per-topic statistics            | V0.1   |
| Topic tree, search by filter, substring, activity or silence                | V0.1   |
| Payload classification (JSON, text, number, boolean, binary) and safe views | V0.1   |
| Read policy with deny precedence, applied at ingest; payload redaction      | V0.1   |
| Observation coverage and explicit limitations in every answer               | V0.1   |
| `serve` and `check`, with documented exit codes and graceful shutdown       | V0.1   |
| JSON schema inference, schema-change detection, related topics              | V0.2   |
| Bounded captures and incident timelines                                     | V0.3   |
| Guarded publishing, off unless enabled                                      | V0.4   |
| OpenTelemetry, persistent storage, HTTP transport with authentication       | V0.4+  |

The six tools, with their inputs and errors: [docs/mcp-tools.md](docs/mcp-tools.md).

## Facts, observations, limitations

Every answer separates what was **observed directly** (counts, receipt times, delivered QoS,
payloads) from what was **computed** (rates, intervals), and states what the server **could not
see**: how long it has been watching, which subscriptions were refused, when it was
disconnected, what was sampled or truncated.

MQTT makes this necessary. Receipt time is not publish time. Delivered QoS is not the
publisher's QoS. A retained message replayed at subscribe time is not a live message.
**"Not observed" never means "does not exist"**, and every answer says so in words a model can
read ([ADR-0011](docs/adr/0011-facts-observations-limitations.md)).

## Security model

Connecting a language model to an operational broker deserves care, so the design starts there.

- **There is no publish path.** Not disabled, not hidden behind a flag — absent. A test asserts
  that no publish tool is registered.
- **Deny beats allow**, globally and per broker, and a denied topic is dropped **at ingest**:
  never stored, never counted, never listed. There is no argument an agent can pass to get
  around it.
- **Payloads and topic names are untrusted data.** They are classified, truncated, escaped and
  redacted before an agent sees them; binary is never dumped. The tools that show payloads say
  so in their own description, so it reaches the model with the data.
- **Secrets are references**, never values in a file, and print as `[REDACTED]` wherever they
  are touched — logs, errors, serialization.
- **Everything is bounded**, and whatever is dropped is counted and reported in the answer, not
  only in a dashboard.
- **Your broker's ACLs remain the authoritative control.** This policy is a second lock. Give
  the server a dedicated read-only account.

What this does **not** protect you from is written down too, including the broker that accepts
a subscription and then delivers nothing on it — which no MQTT client can detect:
[docs/security.md](docs/security.md).

## Supported brokers

Any standards-compliant MQTT 3.1.1 or 5 broker, with no broker-specific code in the core:
Eclipse Mosquitto, EMQX, HiveMQ, NanoMQ, VerneMQ, AWS IoT Core, Azure Event Grid MQTT broker,
and others. Configurations for the less obvious ones are in
[examples/configs](examples/configs/README.md).

Discovery needs an account allowed to subscribe to the topics of interest. Where a broker
refuses a subscription, the refusal is reported rather than hidden.

Azure IoT Hub is **not** a general-purpose broker — a client cannot subscribe to other devices'
topics — so namespace discovery is not possible there.

## Architecture

```text
AI agent (MCP client)
        │  stdio
   @kadeya/mqtt-intel-mcp     six tools · schemas · rendering · CLI
        │  Engine
   @kadeya/mqtt-intel-core    policy · discovery · ingest · catalogue · payloads
        │  ports
   MQTT brokers
```

The engine is a plain TypeScript library with **no MCP dependency**, so the same code can back
a CLI, a service or someone else's program. MQTT access, storage, time, logs and metrics all
sit behind ports, each with a fake beside it.

[docs/architecture.md](docs/architecture.md) · [the 18 ADRs](docs/adr/README.md) ·
[the design document](docs/proposal/README.md)

## Repository layout

| Path                  | Content                                                    |
| --------------------- | ---------------------------------------------------------- |
| `packages/core`       | `@kadeya/mqtt-intel-core`: the engine, as a library        |
| `packages/mcp-server` | `@kadeya/mqtt-intel-mcp`: the MCP server and the CLI       |
| `examples/`           | A fictional factory, five configurations, four MCP clients |
| `docs/`               | Reference, decisions, design document                      |
| `tools/eslint`        | The local rule that enforces the core's module boundaries  |

## Roadmap

| Version | Theme                                                                      |
| ------- | -------------------------------------------------------------------------- |
| 0.1     | Foundation: multi-broker, discovery, catalogue, safe payloads, six tools   |
| 0.2     | Intelligence: schema inference, topic description, activity metrics        |
| 0.3     | Diagnostics: bounded captures, incident timelines, schema-change detection |
| 0.4     | Guarded publishing, OpenTelemetry                                          |
| 0.5     | Deployment: HTTP transport with authentication, persistent storage         |
| 1.0     | Stable tool and library API under semver                                   |

What is deliberately excluded, and why:
[V0.1 scope](docs/proposal/04-scope-v0.1.md).

## FAQ

**Is this an MQTT broker?** No. It connects to yours as a client.

**Does it need an API key, or send anything to a model provider?** No. There is no LLM inside
and no dependency on any AI provider. Your agent's own client decides what reaches its model,
which is why payloads are truncated and redacted before they leave the engine.

**Can an agent break my plant with it?** There is no publish path in this version. When guarded
publishing arrives it will be off unless enabled, behind an allow-list with deny precedence.
Pair it with a read-only broker account either way.

**Will it flood my broker?** Discovery subscriptions are configured per broker and reduced to a
minimal covering set. Ingestion counts every message, inspects a sample and stores a bounded
window, reporting whatever it dropped.

**Why does `--version` print nothing when I redirect it?** Because it goes to stderr. The same
binary serves MCP over stdio, where stdout carries protocol frames and a stray line is a parse
error rather than a message — so everything the CLI says goes to stderr, which is also where
MCP clients collect a server's output ([ADR-0018](docs/adr/0018-cli-contract.md)).

**Does it work with Sparkplug B?** Not in the core: payloads classify as binary. A decoder
extension point is planned, so Sparkplug can arrive as a separate package.

**Is it usable outside industry?** Yes. Industrial automation drives the design, but there is
no business logic in the core: IoT, energy, automotive, smart buildings, robotics, logistics,
home automation and generic event-driven systems all work the same way.

**How does it differ from other MQTT MCP servers?** Most wrap connect, subscribe and publish.
This one is built around a persistent catalogue, safe payload handling, explicit observation
coverage, a security policy with deny precedence, and multi-broker support — in TypeScript, as
a reusable library.

## Contributing

Requirements: Node.js 22 (≥ 22.13) or 24 — LTS lines only
([ADR-0001](docs/adr/0001-typescript-on-node-lts.md)).

```bash
npm ci
npm run check            # build, typecheck, lint, format, test
npm run test:integration # real Mosquitto and the example stack; needs Docker
```

Contributions are accepted under Apache-2.0 with a DCO sign-off (`git commit -s`), with no CLA.
[CONTRIBUTING.md](CONTRIBUTING.md) has the rest, including what a reviewer will look for.

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).

Maintained by [Kadeya](https://github.com/kadeyaorg).

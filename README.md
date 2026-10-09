# MQTT Intelligence MCP

**Give AI agents safe, structured and observable access to MQTT infrastructures.**

MQTT Intelligence MCP is an open-source [Model Context Protocol (MCP)](https://modelcontextprotocol.io)
server, and a Node.js library, that lets an AI agent explore, understand and diagnose an
MQTT namespace: discover which topics exist, see what is published on them, inspect payloads
safely, and reconstruct what happened during an incident. It is **read-only by default**,
works with **any standard MQTT broker**, and tells the agent **what it could not observe**
so the agent does not invent the rest.

> ## Status: pre-release
>
> The architecture is designed and the repository is set up. **The engine is not
> implemented yet**, nothing is published to npm, and the commands below do not work yet.
> Everything on this page marked _planned_ is a commitment to build, not a shipped feature.
> Progress follows the [implementation plan](docs/proposal/05-implementation-plan.md).

---

## Why it exists

MQTT has no standard way to list topics, no schema, and no description of what a namespace
contains. An engineer facing an unfamiliar broker has to subscribe to `#` and read raw bytes.
An AI agent given a plain MQTT client has the same problem, plus three of its own: it can
flood its context with a firehose of messages, it can be misled by payloads that look like
instructions, and it can accidentally publish to a topic that moves a real machine.

This project gives the agent the structured context instead: a catalog, statistics, safe
payload views, and explicit limits. The reasoning stays with the agent; the engine only
reports what it observed.

## What an agent will be able to ask (planned)

- What topics exist on this broker?
- Find all topics related to the robot.
- What is currently being published on this machine?
- Describe `factory/line-01/robot/status`.
- What does the payload of this topic look like? Infer its schema.
- Which topics stopped publishing? Which have the highest message rate?
- Capture everything under `factory/line-01/#` for 30 seconds.
- Build a timeline of what happened during this incident. What changed before the machine stopped?
- Explain the MQTT architecture of this system.

## Capabilities

| Capability                                                                  | Status        |
| --------------------------------------------------------------------------- | ------------- |
| Multi-broker connections (MQTT 3.1.1 and 5, TLS, mTLS, WebSockets)          | planned V0.1  |
| Passive topic discovery and a bounded topic catalog                         | planned V0.1  |
| Topic tree, search, per-topic statistics                                    | planned V0.1  |
| Payload classification (JSON, text, number, boolean, binary) and safe views | planned V0.1  |
| Read policy with deny precedence, and payload redaction                     | planned V0.1  |
| Observation coverage: what was observed, and what was not                   | planned V0.1  |
| JSON schema inference, schema-change detection, related topics              | planned V0.2  |
| Bounded captures and incident timelines                                     | planned V0.3  |
| Guarded publishing, disabled by default                                     | planned V0.4  |
| OpenTelemetry metrics, persistent storage, HTTP transport with auth         | planned V0.4+ |

## Security model

Connecting an AI agent to an operational broker deserves care, so the design starts there:

- **Read-only by default.** Publishing is not implemented, and when it arrives it will stay
  off unless explicitly enabled; while disabled, the tool is not even exposed to the agent.
- **A deny rule always beats an allow rule**, for reading and for publishing.
- **Denied topics are dropped on arrival**: never counted, never stored, never returned.
- **Payloads are untrusted data.** They are typed, truncated, escaped and redacted before
  an agent ever sees them; binary is never dumped. Device data can carry text that looks
  like instructions, and it is treated as data.
- **Secrets stay out of the repository and the logs**: environment or file references only,
  never plain values in configuration.
- **Bounded by construction**: limits on tracked topics, payload sizes, stored history and
  captures, with visible counters whenever a limit is hit.
- **The broker ACL remains authoritative.** The documented deployment uses a dedicated
  read-only broker account; our policy protects against agent mistakes, not against a
  compromised host.

Details: [ADR-0004](docs/adr/0004-read-only-by-default.md),
[ADR-0009](docs/adr/0009-bounded-ingestion.md),
[ADR-0010](docs/adr/0010-payload-classification-and-safe-views.md).

## Facts, observations, limitations

Every answer separates what was **observed directly** (counts, timestamps, payloads) from
what was **computed** (rates, intervals), and states what the engine **could not see**:
how long it has been observing, which subscriptions the broker refused, when it was
disconnected, what was sampled or truncated.

MQTT makes this necessary. Receipt time is not publish time. Delivered QoS is not the
publisher's QoS. A retained message replayed at subscribe time is not a live message.
**"Not observed" never means "does not exist"** ([ADR-0011](docs/adr/0011-facts-observations-limitations.md)).

## Supported brokers

Any standards-compliant MQTT 3.1.1 or MQTT 5 broker, with no broker-specific code in the
core: Eclipse Mosquitto, EMQX, HiveMQ, NanoMQ, VerneMQ, AWS IoT Core, Azure Event Grid MQTT
broker, and others. Discovery needs an account allowed to subscribe to the topics of
interest; where a broker refuses a subscription, that refusal is reported rather than hidden.

Azure IoT Hub is **not** a general-purpose broker — a client cannot subscribe to other
devices' topics — so namespace discovery is not possible there.

## Quick start (planned)

Once V0.1 ships, pointing an MCP client at a broker will look like this:

```json
{
  "mcpServers": {
    "mqtt": {
      "command": "npx",
      "args": ["-y", "@kadeya/mqtt-intel-mcp"],
      "env": { "MQTT_URL": "mqtt://localhost:1883" }
    }
  }
}
```

Then, in the agent: _"Connect to my MQTT broker and explain its architecture."_

Works with any MCP client (Claude Code, Claude Desktop, Cursor, VS Code, and others).

## Architecture

```text
AI agent (MCP client)
        │  stdio
   MCP server            @kadeya/mqtt-intel-mcp   tools, schemas, rendering
        │
   Engine               @kadeya/mqtt-intel-core   discovery · catalog · policy · payloads
        │
   MQTT brokers
```

The engine is a plain TypeScript library with no MCP dependency, so the same code can later
back a CLI or a service. MQTT access, storage, time, logs and metrics all sit behind ports.

- [Architecture proposal](docs/proposal/README.md): analysis, ecosystem review, data model,
  lifecycles, security boundaries, V0.1 scope, implementation plan.
- [Architecture Decision Records](docs/adr/README.md): 17 accepted decisions, with the
  alternatives that were rejected.

## Repository layout

| Path                  | Content                                                |
| --------------------- | ------------------------------------------------------ |
| `packages/core`       | `@kadeya/mqtt-intel-core`: the engine, as a library    |
| `packages/mcp-server` | `@kadeya/mqtt-intel-mcp`: the MCP server and CLI       |
| `tools/eslint`        | Local lint rule enforcing the core's module boundaries |
| `docs`                | Architecture proposal and ADRs                         |

The `@kadeya` npm scope is not confirmed yet, and both packages are marked private: nothing
can be published until the first release.

## Roadmap

| Version | Theme                                                                      |
| ------- | -------------------------------------------------------------------------- |
| 0.1     | Foundation: multi-broker, discovery, catalog, safe payloads, six MCP tools |
| 0.2     | Intelligence: schema inference, topic description, activity metrics        |
| 0.3     | Diagnostics: bounded captures, incident timelines, schema-change detection |
| 0.4     | Guarded publishing, OpenTelemetry                                          |
| 0.5     | Deployment: HTTP transport with authentication, persistent storage         |
| 1.0     | Stable tool and library API under semver                                   |

Details and what is deliberately excluded: [V0.1 scope](docs/proposal/04-scope-v0.1.md).

## FAQ

**Is this an MQTT broker?** No. It connects to your existing broker as a client.

**Does it need an API key, or send data to a model provider itself?** No. It has no LLM
inside and no dependency on any AI provider. Your agent's own client decides what is sent
to its model — which is why payloads are truncated and redacted before they leave the
engine.

**Can an agent break my plant with it?** Publishing is not implemented, and will ship
disabled, behind an allow-list with deny precedence. Pair it with a read-only broker
account.

**Will it flood my broker?** Discovery subscriptions are configurable per broker, and
ingestion is bounded: it counts every message, inspects a sample, and stores a bounded
window, reporting whatever it dropped.

**Does it work with Sparkplug B?** Not in the core. Payloads are classified as binary, and a
decoder extension point is planned so Sparkplug can arrive as a separate package.

**Is it usable outside industry?** Yes. Industrial automation is a driving use case, but
there is no business logic in the core: IoT, energy, automotive, smart buildings, robotics,
logistics, home automation and generic event-driven systems all work the same way.

**How does it differ from other MQTT MCP servers?** Most wrap connect, subscribe and
publish. This one is built around a persistent catalog, safe payload handling, explicit
observation coverage, a security policy with deny precedence, and multi-broker support, in
TypeScript, as a reusable library.

## Contributing

The project is in its bootstrap phase; contribution guidelines arrive with the first
release. Contributions are accepted under Apache-2.0 with a DCO sign-off (`git commit -s`),
with no CLA.

Requirements: Node.js 22 (≥ 22.13) or 24 — only LTS lines are supported
([ADR-0001](docs/adr/0001-typescript-on-node-lts.md)).

```bash
npm ci
npm run check
```

`npm run check` runs, in order: `build`, `typecheck`, `lint`, `format:check` and `test`.

Changes reach `main` through a pull request. `npm install` points git at the hooks in
[`.githooks`](.githooks), where a `pre-push` hook refuses direct pushes to `main`; set
`ALLOW_PUSH_TO_MAIN=1` to override it. Server-side protection is prepared in
[`.github/rulesets`](.github/rulesets/README.md).

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).

Maintained by [Kadeya](https://github.com/kadeyaorg).

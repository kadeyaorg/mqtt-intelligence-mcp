# 04 — V0.1 scope and revised roadmap

> Status: **Approved on 2026-09-18.** Decisions are recorded in the [ADRs](../adr/README.md), which prevail over this document where they differ.

## 1. V0.1 goal (one sentence)

> A developer runs one command, points an MCP client at a broker, and within five minutes
> the agent can **list brokers, map the topic namespace, search topics, describe a topic and
> read its recent messages**, safely, with bounded memory and explicit statements of what
> the engine could not see.

## 2. In scope

### Engine (`@kadeya/mqtt-intelligence-core`)

- [x] Configuration: YAML + zod, secret references (`env`, `file`), env-only quick start,
      unknown-key rejection, precise error messages.
- [x] Topic domain: validation, matching, `covers`, `intersects` (property-tested).
- [x] Multi-broker registry; connection state machine with timeouts, exponential backoff with
      jitter, no automatic retry after authentication failure, graceful close.
- [x] MQTT 3.1.1 and 5; TCP, TLS, mTLS, WebSockets (`ws`/`wss`); username/password.
- [x] Subscription manager: leases, minimal covering set, per-filter SUBACK handling,
      resubscription after reconnect.
- [x] Read policy (allow/deny, deny precedence) with ingest-time filtering; JSON key redaction.
- [x] Bounded ingest pipeline (ADR-0009) with every budget and counter.
- [x] Passive discovery with observation coverage and gaps.
- [x] `TopicCatalog` and `MessageStore` ports, memory implementations, contract test suite.
- [x] Payload classification and LLM-safe views.
- [x] Topic statistics: counts, bytes, delivered QoS, retained state, payload kinds, EWMA rate,
      inter-arrival statistics.
- [x] Queries: broker status, discovery summary, topic tree, search (filter + substring +
      sort + cursor), describe (without schema), recent messages.
- [x] `Answer` envelope with facts, observations, coverage and limitations.
- [x] Typed errors with stable codes; sanitization.
- [x] Logger (JSON on stderr, redaction) and metrics port (no-op default).

### MCP server (`@kadeya/mqtt-intelligence-mcp`)

- [x] SDK v2, stdio transport.
- [x] Six tools: `mqtt_list_brokers`, `mqtt_discover_topics`, `mqtt_topic_tree`,
      `mqtt_search_topics`, `mqtt_describe_topic`, `mqtt_get_recent_messages`.
- [x] Input/output schemas, `structuredContent`, compact text renderings, annotations,
      progress and cancellation for `mqtt_discover_topics`.
- [x] Error mapping; audit log per tool call.
- [x] CLI: default `serve`, `check` (validate config + test each broker's connectivity and
      discovery subscription), `--config`, `--version`, `--help` (`node:util` `parseArgs`).
- [x] Graceful shutdown on SIGINT, SIGTERM and stdin close.

### Repository and developer experience

- [x] Monorepo, strict TypeScript, ESLint with module boundaries, Prettier, Vitest.
- [x] CI: lint, typecheck, unit tests (Linux/Windows/macOS), integration tests with
      Mosquitto (Linux); blocking on Node 22/24 (LTS), Node 26 experimental and non-blocking.
- [x] `examples/industrial-machine`: Docker Compose (Mosquitto + fictional factory simulator
      with a reproducible "robot error" incident) and a ready-to-use config.
- [x] `examples/configs`: single broker, multi-broker, TLS/mTLS, AWS IoT Core,
      Azure Event Grid MQTT.
- [x] `examples/mcp-clients`: Claude Desktop, Claude Code, Cursor, VS Code snippets.
- [x] `.env.example`.
- [x] Docs: README (the nine sections requested), `architecture.md`, `configuration.md`,
      `security.md` (threat model), `mcp-tools.md`, `observability.md`, `releasing.md`, ADRs.
      Discovery and storage are documented in ADR-0007, ADR-0008 and ADR-0009 and in the
      architecture document; separate pages would have duplicated them and drifted.
- [x] LICENSE, NOTICE, CONTRIBUTING (DCO), CODE_OF_CONDUCT (Contributor Covenant),
      SECURITY.md (private reporting through GitHub advisories), CHANGELOG (Changesets),
      issue and PR templates, CODEOWNERS, Dependabot/Renovate, CodeQL.
- [ ] Release 0.1.0 to npm with provenance. **Prepared, not done:** Changesets, the release
      workflow with provenance, and per-package LICENSE, NOTICE, README and CHANGELOG are in
      place. Both packages stay `private` until the `@kadeya` npm organisation is confirmed
      (ADR-0002), and the workflow refuses to publish while they are. See
      [releasing.md](../releasing.md).

## 3. Explicitly out of scope for V0.1

| Item                                                         | Target                       | Reason                                                          |
| ------------------------------------------------------------ | ---------------------------- | --------------------------------------------------------------- |
| Schema inference, schema-change detection                    | V0.2 / V0.3                  | Needs the catalog and payload views first                       |
| Related topics, topic pattern folding                        | V0.2                         | Heuristics need real catalogs to be tuned                       |
| `mqtt_get_activity` (top rates, silent topics)               | dropped                      | Became filters on `mqtt_search_topics` instead (ADR-0020)       |
| MCP prompts (`explain-architecture`, `investigate-incident`) | V0.2                         | Cheap, but better once schema exists                            |
| Payload decoder plugins (Sparkplug B…)                       | V0.2 (API), later (decoders) | Extension point first                                           |
| `mqtt_capture`, `mqtt_build_timeline`                        | V0.3                         | Requires capture handles, progress, full-fidelity bounded store |
| **Any publish capability**                                   | V0.4                         | Read-only product first; dedicated threat review                |
| OpenTelemetry bridge                                         | V0.4                         | Port and metric names exist in V0.1                             |
| Streamable HTTP transport + authentication                   | V0.5                         | Never without authentication                                    |
| Persistent storage (SQLite, Redis, Postgres/Timescale)       | V0.5+                        | Ports and contract tests exist in V0.1                          |
| Broker admin API enrichers (EMQX, HiveMQ…)                   | later, separate packages     | Not broker-agnostic                                             |
| Configuration hot reload                                     | later                        | Restart is acceptable for V0.x                                  |
| Web UI, dashboard, chatbot, embedded LLM, vector DB          | never                        | Out of product scope                                            |

## 4. V0.1 acceptance criteria

1. `npx @kadeya/mqtt-intelligence-mcp check` against the example stack succeeds in
   < 10 s on a laptop.
2. From a clean machine with Docker and Node, the quick start (clone or `npx`, compose up,
   add MCP config) takes under five minutes by following the README only.
3. With the example stack, an agent answers "What topics exist on this broker?" and
   "Describe `factory/line-01/robot/status`" correctly, and states the observation window.
4. A 100,000-message burst over 10,000 topics keeps resident memory within the configured
   budgets (+ a documented fixed overhead), with exact counts and non-zero, reported drop
   counters when budgets are deliberately set low.
5. Killing and restarting the broker: state goes `connected → backoff → connected`,
   discovery resumes, the gap appears in coverage.
6. Wrong password: state `failed`, no retry loop, error `BROKER_AUTH_FAILED`, no secret in
   logs (asserted by tests capturing stderr).
7. A read-denied subtree never appears in any tool output, even when `#` is subscribed.
8. Binary, empty, invalid UTF-8, huge and deeply nested payloads all render safely.
9. Zero `any`, zero lint warnings, all CI jobs green, coverage ≥ 90 % lines on `core`.

### Where they stand (2026-10-11)

| #   | Criterion                                                            | Status                                                                                                                                                   |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `check` against the example stack in < 10 s                          | **Met.** 9 s from `compose up` to exit 0; `check` itself about 1 s.                                                                                      |
| 2   | Quick start under five minutes from the README alone                 | **Met.** A clean clone, install, build, `compose up` and `check` took 26 s.                                                                              |
| 3   | An agent answers the two questions and states its window             | **Met.** Asserted end to end against the example stack.                                                                                                  |
| 4   | A 100,000-message burst stays within budget                          | **Partly.** Budgets, drop counters and eviction are asserted by unit tests; the burst itself has not been run and resident memory has not been measured. |
| 5   | Broker restart: connected → backoff → connected, gap in coverage     | **Met.** Integration test against a restarted Mosquitto.                                                                                                 |
| 6   | Wrong password: failed, no retry loop, no secret in logs             | **Met.** Integration test, with stderr captured and asserted.                                                                                            |
| 7   | A read-denied subtree appears in no output                           | **Met.** Asserted against the example stack while the topic is being published.                                                                          |
| 8   | Binary, empty, invalid UTF-8, huge and nested payloads render safely | **Met.** Unit and property tests.                                                                                                                        |
| 9   | Zero `any`, zero lint warnings, CI green, core lines ≥ 90 %          | **Met.** `npm run test:coverage:core`: **94.96 %** lines, 96.52 % functions, unit and integration together.                                              |

Criterion 4 is the one outstanding measurement, and it needs a machine with a real broker and
a load generator rather than a CI runner.

## 5. Revised roadmap

| Version  | Theme                            | Content                                                                                                                                                                                                                                                                                                                                                        |
| -------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.1**  | Foundation & safe observation    | This document                                                                                                                                                                                                                                                                                                                                                  |
| **0.2**  | Intelligence                     | Incremental schema inference (with optional fields, type unions, map detection) and JSON Schema export; full `mqtt_describe_topic` (schema + related topics with explained reasons); `mqtt_infer_schema` (topic or pattern); activity as filters on `mqtt_search_topics` rather than a tool (ADR-0020); topic pattern folding in the tree; payload decoder API |
| **0.3**  | Diagnostics                      | `mqtt_capture` (bounded, cancellable, progress, `captureId`), `mqtt_build_timeline` (ordering by receipt, repetition folding, field-level change events, measured deltas, cross-broker caveats), schema change history, inactivity detection relative to own disconnections                                                                                    |
| **0.4**  | Controlled write & observability | `mqtt_publish` per ADR-0004 (not registered unless enabled; allow/deny; limits; audit; elicitation confirmation), OpenTelemetry bridge package, publish-specific threat review                                                                                                                                                                                 |
| **0.5**  | Deployment                       | Streamable HTTP with authentication, SQLite store via `node:sqlite` (catalog survives restarts), Docker image, enterprise deployment guide, performance benchmarks published                                                                                                                                                                                   |
| **0.6+** | Ecosystem                        | Sparkplug B decoder package, Redis/Postgres stores, broker admin enrichers, MCP-over-MQTT transport evaluation                                                                                                                                                                                                                                                 |
| **1.0**  | Stability                        | Frozen tool API and library API under semver, documented support policy                                                                                                                                                                                                                                                                                        |

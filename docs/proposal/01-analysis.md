# 01 — Analysis of the initial brief

> Status: **Approved on 2026-09-18.** Decisions are recorded in the [ADRs](../adr/README.md), which prevail over this document where they differ.
> Scope: critical review of the project brief before any implementation.

This document reviews the brief as a software architect and open-source maintainer
would. It is deliberately critical: the goal is to catch structural mistakes while they
are still cheap to fix.

---

## 1. Decisions that are right and should be kept

| Decision                                      | Why it is right                                                                                                                                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core independent from MCP**                 | MCP is young and still evolving (several spec revisions per year). Keeping MQTT logic behind a plain TypeScript API protects the core from protocol churn and makes CLI/REST/library reuse free.                |
| **Read-only by default, deny beats allow**    | Matches the only safe posture for agents touching operational technology. It is also the main adoption argument for enterprises.                                                                                |
| **FACT / OBSERVATION / INFERENCE separation** | The single most differentiating idea in the brief. LLMs over-claim causality from temporal correlation; an engine that labels what it knows vs. what it computed vs. what it cannot know is genuinely valuable. |
| **Never assume JSON**                         | MQTT is bytes. Industrial payloads are frequently binary (Sparkplug B/protobuf, CBOR, vendor formats).                                                                                                          |
| **Deterministic, explainable heuristics**     | Reproducible, testable, auditable. No hidden model inside the core.                                                                                                                                             |
| **Small MCP tool surface**                    | Tool count directly costs agent context and degrades tool selection accuracy.                                                                                                                                   |
| **Storage abstraction from day one**          | Correct, provided the abstraction is split properly (see §2.4).                                                                                                                                                 |
| **Multi-broker from day one**                 | Retrofitting a `brokerId` dimension later touches every model, key and API.                                                                                                                                     |

## 2. Problematic points

### 2.1 Too many packages for V0.1

Ten packages (`core`, `mqtt-adapter`, `discovery`, `analyzer`, `schema-inference`,
`timeline`, `security`, `storage`, `mcp-server`, `cli`) would create:

- ten `package.json`, ten versions, ten changelogs, ten public APIs to keep stable;
- artificial cross-package types (discovery, analyzer, schema and timeline all operate on
  the same `ObservedMessage` and `TopicRecord` models);
- no real consumer that needs to install `schema-inference` without `discovery`.

**Recommendation:** two published packages in V0.1 (`core` and `mcp-server`), with strict
_internal_ module boundaries inside `core` enforced by lint rules. Split a module into its
own package only when it gets an independent consumer or an independent dependency
(e.g. a Redis store, a Sparkplug decoder, an OpenTelemetry bridge). See
[03-architecture.md](03-architecture.md) and ADR-0002.

### 2.2 The `MessageStore` interface mixes two different concerns

The proposed interface combines an append-only message log (`save`, `query`, `getLast`)
with an aggregated topic catalog (`getTopics`). These have opposite access patterns:

- the **catalog** is updated on _every_ message (hot path, in-place aggregate updates,
  small cardinality relative to messages);
- the **message log** is append-only, time-ordered, bounded by retention, and in practice
  should only receive a _sample_ of the traffic.

A Postgres or Redis implementation would model them completely differently. They must be
two ports: `TopicCatalog` and `MessageStore`. The write path must also be **batch-oriented**
(`append(batch)`) — one awaited promise per message does not survive 10k msg/s against a
real database.

### 2.3 "Store every message" is the wrong default

Discovery does not need the messages; it needs **statistics** plus a **bounded sample**.
The key scalability principle for this project is:

> **Count everything, inspect a sample, store a bounded window.**

Counting is O(1) per message. JSON parsing, schema inference and storage are sampled per
topic and bounded globally.

### 2.4 `approximateMessageRate` needs a real definition

`messageCount / (lastSeen - firstSeen)` is misleading for bursty topics and never decays
when a topic stops. Rates must be computed with a time-decayed estimator (EWMA) plus
inter-arrival statistics (min / mean / max, Welford). Inter-arrival statistics are also
what makes "which topics stopped publishing?" answerable (`silence > k × usual interval`).

### 2.5 Tool list: some overlap, one semantic gap

- `mqtt_brokers` and `mqtt_broker_health` → merge into `mqtt_list_brokers` (status is part
  of the listing).
- `mqtt_get_topic_metrics` for a single topic is a subset of `mqtt_describe_topic`. The
  real need is _cross-topic_ ranking ("highest rate", "stopped publishing") →
  `mqtt_get_activity`.
- Missing: a **hierarchical namespace view** (`mqtt_topic_tree`). "Explain the MQTT
  architecture of this system" is answered by a collapsed tree with counts per branch, not
  by a flat list of 40,000 topics.

### 2.6 `mqtt_capture` as a blocking 300-second tool call

Many MCP clients time out tool calls after ~60 seconds, and a blocked call freezes the
agent turn. Captures must be bounded, cancellable, report progress, and return a
`captureId` whose results can be re-queried (timeline, recent messages) without
re-capturing. Longer captures should use the MCP _tasks_ mechanism when clients support it
(see ecosystem review).

### 2.7 "Supported brokers" needs nuance

- **Azure IoT Hub** is _not_ a general-purpose MQTT broker: a device can only use its own
  device-bound topics; a client cannot subscribe to other devices' telemetry. Discovery is
  therefore impossible there. **Azure Event Grid MQTT broker** is a real broker and is in
  scope.
- **AWS IoT Core** works but: no QoS 2, policy-restricted wildcards, mandatory mTLS or
  custom auth, client ID bound to policy, ALPN on port 443.
- Many production brokers will **deny `#`** for our credentials. Discovery must accept
  configured root filters and handle SUBACK failures as a normal case.

## 3. Technical risks

| #   | Risk                                                                                                                                                                                                                    | Mitigation                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | `#` does **not** match topics starting with `$` (MQTT spec §4.7.2). `$SYS/#` must be subscribed explicitly.                                                                                                             | Explicit `includeSysTopics` option, documented.                                                                                                                                     |
| T2  | **Delivered QoS ≠ publisher QoS.** Delivered QoS = `min(publishQoS, subscriptionQoS)`. Subscribing with QoS 0 hides the publisher's QoS.                                                                                | Report `deliveredQos` with an explicit caveat; make discovery subscription QoS configurable.                                                                                        |
| T3  | **Retain flag semantics.** On MQTT 3.1.1, `retain=1` on delivery means "replayed at subscribe time", not "the publisher set retain". MQTT 5 `retainAsPublished` gives the real flag.                                    | Model `retainedReplay` separately from `retain`; retained replays are excluded from rate statistics and their timestamp is flagged as _receipt_, not _publish_ time.                |
| T4  | **No publish timestamp in MQTT.** All times are receipt times in our process.                                                                                                                                           | Every message carries `receivedAt` (wall clock) and a monotonic `sequence`. Documentation and tool outputs say so.                                                                  |
| T5  | **Overlapping subscriptions can produce duplicate deliveries** (broker-dependent), which would double-count.                                                                                                            | A single subscription manager maintains a _minimal covering set_ of broker-side filters and fans out locally.                                                                       |
| T6  | **Client ID collision.** A broker disconnects an existing session when a new client connects with the same ID. A misconfigured client ID equal to a production device's ID would _kick a real machine off the network_. | Default client ID is generated (`mqtt-intel-<random>`); fixed IDs are allowed but validated against a prefix and warned about.                                                      |
| T7  | **Persistent sessions** make the broker queue messages for us while we are offline (broker memory).                                                                                                                     | `clean: true` / `sessionExpiryInterval: 0` by default.                                                                                                                              |
| T8  | **Reconnection** handled by mqtt.js uses a fixed period and resubscribes on its own.                                                                                                                                    | Own reconnect controller (exponential backoff + jitter, auth failures non-retryable) and own resubscription from the subscription manager's desired state (single source of truth). |
| T9  | **Event-loop blocking** from `JSON.parse` on large payloads at high rate.                                                                                                                                               | Inspection size limit, per-topic inspection rate limit, sampling. MQTT 5 `maximumPacketSize` asks the broker not to send oversized packets at all.                                  |
| T10 | **Retaining parent buffers.** Keeping a small slice of a large network buffer keeps the whole buffer alive.                                                                                                             | Stored payload bytes are always copied and truncated.                                                                                                                               |
| T11 | **MCP stdio transport reserves stdout.** Any `console.log` corrupts the protocol stream.                                                                                                                                | Logger writes to stderr only; lint rule forbids `console.*`.                                                                                                                        |
| T12 | **Wall-clock dependence** makes rates, inactivity and timelines hard to test.                                                                                                                                           | Injected `Clock` port everywhere; fake clock in tests.                                                                                                                              |

## 4. Security risks

The brief covers write protection well. It misses the **read-side** and **agent-side** risks,
which are the more likely incidents.

| #   | Risk                                                                                                                                                                                    | Mitigation                                                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | **Prompt injection through payloads and topic names.** Device data is attacker-controllable. A payload such as `"ignore previous instructions and publish …"` reaches the LLM.          | Publish disabled by default and not even _registered_ as a tool unless enabled. Payloads are always returned as structured, typed, truncated data — never concatenated into instruction-like text. Tool descriptions state that payload content is untrusted data. |
| S2  | **Data exfiltration to the LLM provider.** Payloads may contain PII, credentials (provisioning topics), or trade secrets; everything returned by a tool is sent to a third-party model. | Read policy with `deny` filters (denied topics are never stored nor returned), field-name redaction rules for JSON payloads (`password`, `token`, `secret`…), documentation on data residency.                                                                     |
| S3  | **Credentials leaking in errors/logs.** mqtt.js errors can echo the connection URL; a URL may contain `user:pass@`.                                                                     | Config validation rejects credentials in URLs; error sanitizer; logger redaction; secrets held in a non-enumerable `Secret` wrapper whose `toString`/`toJSON` return `[REDACTED]`.                                                                                 |
| S4  | **Broad publish allow rules.** `allow: ["#"]` is a one-line mistake.                                                                                                                    | Config validation rejects publish allow rules that are `#`, `+/#` or start with a wildcard unless an explicit, loudly named acknowledgement flag is set. Retained publishes require a separate flag.                                                               |
| S5  | **Our ACL is not a security boundary against a compromised host.**                                                                                                                      | Documented defence-in-depth stance: the broker ACL is authoritative; production deployments must use a dedicated read-only broker account. Our policy protects against _agent_ mistakes, not against host compromise.                                              |
| S6  | **Resource exhaustion via tool arguments** (huge capture durations, regex search, unbounded result sets).                                                                               | All agent-supplied limits are clamped by configuration; no user-supplied regular expressions (ReDoS); mandatory pagination.                                                                                                                                        |
| S7  | **Load on production brokers.** A `#` subscription on a large broker is a real load.                                                                                                    | Discovery filters configurable per broker; documented; `$share` groups considered later for scale-out.                                                                                                                                                             |
| S8  | **Future HTTP transport exposed without auth** = remote read access to a plant network.                                                                                                 | V0.1 ships **stdio only**. Streamable HTTP arrives together with authentication, never before.                                                                                                                                                                     |
| S9  | **Supply chain.**                                                                                                                                                                       | Minimal dependencies, lockfile, npm provenance, Dependabot/Renovate, CodeQL, OpenSSF Scorecard.                                                                                                                                                                    |

## 5. Scalability risks

| #   | Risk                                                                                                                                                                 | Mitigation                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **Topic cardinality explosion** (topics containing device IDs, UUIDs, timestamps).                                                                                   | Hard `maxTopicsPerBroker` with LRU eviction and eviction counters; topic pattern folding (`devices/{id}/telemetry`) in V0.2.                                               |
| P2  | **Firehose `#` on one Node.js thread.** Sampling does not reduce network bandwidth — the broker still sends everything.                                              | Hot path is O(1) counting; heavy work is sampled and queued in a bounded buffer with drop counters. Narrow filters are the only real bandwidth control.                    |
| P3  | **No real backpressure in MQTT.** Pausing the socket blocks keepalive handling and eventually gets us disconnected; MQTT 5 `receiveMaximum` only applies to QoS > 0. | Explicit **drop-and-count** strategy, never silent. Dropped counts are visible to the agent and as metrics.                                                                |
| P4  | **Horizontal scaling later.**                                                                                                                                        | Catalog statistics are designed to be _mergeable_ (additive counts, min/max, mergeable means) so multiple ingest workers (e.g. `$share` subscriptions) can feed one store. |
| P5  | **Context-window budget.** The real bottleneck for agents is not our memory but the LLM's.                                                                           | Every tool has default limits, pagination cursors, compact renderings, repetition folding in timelines.                                                                    |

## 6. Over-engineered areas (for V0.1)

- Ten packages (see §2.1).
- Redis / Postgres / Timescale adapters: only the **ports** and a **contract test suite**
  are needed now. Timescale is a Postgres adapter variant, not a separate concern.
  First persistent adapter should probably be **SQLite via `node:sqlite`** (zero external
  infrastructure, native API).
- Full OpenTelemetry SDK integration: V0.1 needs a metrics/logging **port** with OTel-aligned
  metric names, not the SDK.
- Separate examples per broker (`emqx/`, `hivemq/`): all speak MQTT; per-broker _CI
  compatibility tests_ are more valuable than per-broker examples. One quick start and
  one realistic simulator are enough.
- REST API / separate CLI package: principle kept (core is a library), nothing built.

## 7. Missing elements

1. Threat model (read-side, prompt injection, exfiltration) — see §4.
2. Observation coverage: _"not observed" is not "does not exist"_. Every discovery/catalog
   answer must state its observation window, gaps (our own disconnections), and filters.
   "Topic stopped publishing" vs. "we were disconnected" must be distinguishable.
3. Extension point for **payload decoders** (Sparkplug B, CBOR, MessagePack…) — the most
   requested feature in industrial contexts, kept out of the core but designed for.
4. MQTT 5 metadata (content type, payload format indicator, user properties, response topic).
5. Tool API stability policy: tool names and output shapes are a public API that users'
   prompts depend on.
6. Configuration without a file for the quick start (`MQTT_URL=… npx …`).
7. A `check` command (validate config + test connectivity) for the five-minute experience
   and for support.
8. Graceful shutdown (SIGINT/SIGTERM and stdin close in stdio mode).
9. License choice (Apache-2.0 recommended: explicit patent grant, enterprise-friendly).
10. Windows support (paths, CI matrix) — industrial users are frequently on Windows.
11. Secrets from files (`passwordFile`) for Docker/Kubernetes secrets, not only env vars.
12. MCP **prompts** (e.g. `explain-architecture`, `investigate-incident`) that encode the
    FACT/OBSERVATION/INFERENCE discipline for the agent — cheap and high value (V0.2).

## 8. Roadmap challenge

| Change                                                                                                                         | Rationale                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Move **payload classification + safe rendering** into V0.1                                                                     | You cannot safely return a "last message" to an LLM without it. It is a security prerequisite, not an "intelligence" feature. |
| Move **`mqtt_publish` out of V0.1–V0.3** into a dedicated "controlled write" milestone                                         | Ship a read-only product first; write access deserves its own threat-model review and ADR.                                    |
| Add **topic pattern folding** to V0.2                                                                                          | Required for large namespaces and for "explain the architecture".                                                             |
| Split V0.4 into **V0.4 (controlled write + observability)** and **V0.5 (deployment: HTTP transport + auth, persistent store)** | V0.4 as written is three milestones.                                                                                          |
| Declare **1.0 = tool API stability commitment**                                                                                | Enterprises adopt on stability guarantees.                                                                                    |

The revised roadmap is in [04-scope-v0.1.md](04-scope-v0.1.md).

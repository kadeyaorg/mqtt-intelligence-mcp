# ADR-0007 — Passive discovery with explicit observation coverage

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

MQTT has no standard API to list topics. Broker admin APIs exist (EMQX, HiveMQ, Mosquitto
dynamic security, `$SYS`) but are proprietary, often disabled, and not available to an
ordinary client account. The only portable mechanism is to **subscribe and observe**.

Observation has intrinsic blind spots:

- a topic that publishes once a day is invisible after a 5-minute observation;
- `#` does not match `$`-prefixed topics;
- the broker ACL may refuse `#` or restrict visible subtrees;
- we see nothing while disconnected.

## Decision

- Discovery is **passive**: per broker, a discovery lease is acquired on the configured
  `discovery.filters` (default `["#"]`, plus `$SYS/#` only if `includeSysTopics: true`) at
  the configured subscription QoS (default 0).
- Discovery starts on connection (`connect: startup` by default, so the catalog warms up
  while the user starts talking to the agent) and runs until shutdown.
- Retained messages replayed at subscribe time are recorded as such (`retainedReplay`); they
  give an immediate snapshot of state topics but are **excluded from rate statistics**, and
  their timestamp is flagged as receipt time.
- Refused filters (SUBACK ≥ 0x80) are reported in coverage with their reason code; they are
  a normal outcome, not a crash.
- Every discovery-derived answer includes **`ObservationCoverage`**: active and rejected
  filters, observation start, connected duration, disconnection gaps, dropped payloads,
  evicted topics. "Not observed" is never presented as "does not exist".
- `mqtt_discover_topics` can wait (bounded, cancellable, with progress) to extend
  observation before answering.
- Broker-specific topic listing APIs may be added later as **optional enrichers** in
  separate packages; they never replace passive observation in the core.

## Consequences

- Positive: works with every standards-compliant broker, including ones where we only have
  a restricted client account.
- Positive: the agent is told what the engine could not see, which prevents confident but
  wrong answers.
- Negative: rarely-publishing topics need long observation (addressed later by persistent
  storage across restarts).
- Negative: a `#` subscription adds load to the broker; documented, and filters are
  configurable per broker.

## Alternatives considered

- **Broker admin APIs in the core:** not portable; violates broker-agnosticism.
- **On-demand discovery only** (subscribe for N seconds per request): cold, slow answers
  every time, and no history for inactivity detection.

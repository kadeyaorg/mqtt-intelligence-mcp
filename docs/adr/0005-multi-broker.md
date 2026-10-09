# ADR-0005 — Multi-broker as a first-class dimension

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Real deployments have several brokers (sites, regions, staging/production, edge/cloud).
Adding a broker dimension later would change every key, model and API.

## Decision

- Every domain object that relates to MQTT data carries a `brokerId` (`TopicRecord`,
  `ObservedMessage`, coverage, errors, metrics attributes). Storage keys are
  `(brokerId, topic)`.
- A `BrokerRegistry` owns one `BrokerConnection` per configured broker. Connections are
  independent: one broker failing never affects another.
- Broker ids are validated identifiers (`/^[a-z0-9][a-z0-9_-]{0,62}$/`), chosen by the user,
  never derived from URLs (URLs can change; ids appear in prompts and logs).
- In tool calls, `broker` is **optional only when exactly one broker is configured**.
  Otherwise the engine returns `BROKER_AMBIGUOUS` with the list of valid ids. Search may
  target all brokers explicitly.
- Each broker has its own connection mode (`startup` or `lazy`), discovery filters, TLS and
  security overrides. Global limits apply per broker (e.g. `maxTopicsPerBroker`).

## Consequences

- Positive: cross-broker features (comparison, cross-broker timelines) become possible
  without redesign.
- Negative: slightly more verbose tool calls in multi-broker setups; mitigated by the
  single-broker default.

## Alternatives considered

- **One server process per broker:** simpler code, but the agent cannot reason across
  brokers and users must configure N MCP servers.
- **Implicit default broker in multi-broker setups:** convenient but causes silent mistakes
  (querying staging while believing it is production).

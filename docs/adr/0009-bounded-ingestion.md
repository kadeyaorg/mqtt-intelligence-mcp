# ADR-0009 — Bounded ingestion: count everything, inspect a sample, drop and count

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

A `#` subscription on a large broker can deliver tens of thousands of messages per second
across hundreds of thousands of topics. MQTT offers no end-to-end backpressure: pausing the
socket delays keepalive handling and leads to disconnections; MQTT 5 `receiveMaximum` only
applies to QoS 1/2. Sampling locally does not reduce network bandwidth. The Node.js event
loop must stay responsive for MCP requests.

## Decision

- **Hot path (synchronous, O(1) per message):** read-policy check → update the per-topic
  statistics delta in the current batch → keep a reference to the latest payload of that
  topic. No parsing, no awaiting.
- **Flush (every `flushIntervalMs`, default 100 ms):** swap the batch; copy and truncate at
  most one payload per topic; classify up to `inspectionsPerFlush` payloads; call
  `TopicCatalog.applyBatch` and `MessageStore.append`.
- **Budgets, all configurable and all reported when hit:**
  - `maxTopicsPerBroker` with `onTopicLimit: evict-lru | ignore-new` (`topics.evicted`);
  - `pendingPayloadMaxBytes` for payload references awaiting flush
    (`payloads.dropped{reason="budget"}`);
  - `maxInspectBytes` above which payloads are not parsed (`unknown` / `oversized`);
  - `maxStoredPayloadBytes` per stored payload (`truncated: true`);
  - `messageStoreMaxBytes` for the message store (oldest-first eviction).
- **Guarantees stated to the agent:** message counts are exact for tracked topics; the last
  message is exact; recent history is sampled at no more than one message per topic per
  flush interval.
- **Statistics are mergeable** (additive counters, min/max, Welford/Chan for inter-arrival
  times, time-decayed EWMA for rates), enabling several ingest workers later (for example
  MQTT 5 `$share/…` subscriptions) and database-side aggregation.
- MQTT 5 connections advertise `maximumPacketSize` so oversized packets are not sent to us.

## Consequences

- Positive: memory is bounded by construction; the event loop is never blocked by payload
  work; degradation is visible (counters in `mqtt_list_brokers`, metrics, limitations).
- Negative: history is sampled for high-frequency topics. Full-fidelity recording is the
  job of explicit, bounded captures (V0.3).

## Alternatives considered

- **Unbounded queue:** memory grows until the process dies.
- **Socket pause / `handleMessage` backpressure:** keepalive failures and reconnect loops
  (mqtt.js #1935, #2026).
- **Store every message:** does not scale and is not needed for discovery.

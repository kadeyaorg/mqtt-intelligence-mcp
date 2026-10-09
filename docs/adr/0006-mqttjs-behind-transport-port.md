# ADR-0006 — mqtt.js behind a transport port; own reconnection and resubscription

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

mqtt.js (v5.16.0, 2026-09-16) is the de facto MQTT client for Node.js: MQTT 3.1.1 and 5,
TLS/mTLS, WebSockets, bundled types, active maintenance. Version 5.16.0 fixes six security
advisories (a malicious broker could crash clients ≤ 5.15.2). A v6 rewrite is planned.

Some of its behaviours conflict with our needs:

- `subscribeAsync` rejects the whole call if any filter in it is refused, and drops refused
  filters from its resubscribe set;
- automatic reconnection uses a fixed period and resubscribes on its own;
- `connectAsync` may wait through retries without settling for some stream errors;
- holding `handleMessage` for backpressure also delays PINGRESP processing, causing
  keepalive timeouts (issues #1935, #2026);
- topics named `__proto__` or `resubscribe` are lost on its internal resubscribe (open PR
  #2058);
- `keyPath` / `certPath` / `caPaths` appear in the types but are not read.

## Decision

- Depend on **`mqtt@^5.16.0`**; only `core/src/transport/mqttjs/` may import it.
- Define an `MqttTransport` port (single connection attempt, subscribe one filter, unsubscribe,
  close, message and disconnect callbacks, MQTT 5 properties).
- Configure mqtt.js with `reconnectPeriod: 0`, `resubscribe: false`, `clean: true`
  (MQTT 5: `sessionExpiryInterval: 0`), explicit `connectTimeout`, and wrap each attempt in a
  hard timeout.
- Reconnection (exponential backoff with full jitter, no automatic retry after
  authentication failures) lives in `BrokerConnection`. Resubscription is performed by the
  `SubscriptionManager` from its desired state after each successful connection.
- One filter per SUBSCRIBE packet, so SUBACK outcomes are per filter.
- Never block the `message` handler; see ADR-0009.
- TLS material is read by our code (`node:fs/promises`) and passed as Buffers.
- Per-topic state uses `Map`, never plain objects.

## Consequences

- Positive: predictable lifecycle, per-filter errors, testable with a `FakeTransport`, and an
  upgrade path to mqtt.js v6 (or another client) that touches a single directory.
- Negative: we own reconnection logic that mqtt.js already provides; justified by the
  control, observability and safety requirements, and covered by integration tests that
  restart the broker.

## Alternatives considered

- **Use mqtt.js reconnection as is:** fixed period, no distinction between authentication
  and network failures, resubscribe behaviour we cannot observe.
- **Write our own MQTT client on `mqtt-packet`:** too much protocol surface to own.

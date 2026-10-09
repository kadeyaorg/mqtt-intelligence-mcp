# ADR-0015 — Observability through logger and metrics ports, OTel-aligned

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Operators need structured logs and metrics; enterprises expect OpenTelemetry. In stdio mode,
stdout carries the MCP protocol, so any stray output corrupts it. MCP logging notifications
are deprecated in spec 2026-07-28. We want no mandatory observability dependency in V0.1.

## Decision

- **`Logger` port** (levels `trace`…`error`, structured fields, child loggers). Default:
  JSON lines on **stderr**, optional `pretty` format for development. Redaction of known
  secret fields and URL userinfo is built into the default logger. `console.*` is forbidden
  by lint.
- **`MetricsRecorder` port** (counter, up-down counter, histogram, with attributes).
  Default: no-op. Metric names use the `mqtt_intelligence.` namespace and OpenTelemetry
  naming conventions, so the V0.4 `otel` package is a thin bridge to `@opentelemetry/api`.
- Degradation counters (dropped payloads, evicted topics, rejected subscriptions,
  reconnections) are **also exposed to the agent** via `mqtt_list_brokers`.
- Every MCP tool call produces an **audit log** event (tool, broker, sanitized arguments,
  outcome, duration, correlation id).
- No MCP logging notifications.

## Consequences

- Positive: zero observability dependencies in V0.1; OTel integration later without touching
  the engine.
- Negative: we maintain a small logger instead of using an established library; users can
  inject their own (for example pino) through the port.

## Alternatives considered

- **Depend on `@opentelemetry/api` in core now:** the officially recommended pattern for
  libraries, and cheap. Deferred only to keep V0.1 dependency-free; switching the port's
  default implementation later is non-breaking. Open to revisiting.
- **pino as a hard dependency:** excellent, but not necessary for V0.1 volumes.

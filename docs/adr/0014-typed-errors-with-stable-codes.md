# ADR-0014 — Typed errors with stable codes

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Errors are consumed by three audiences: agents (who should self-correct), operators (who read
logs), and library users (who branch on error types). Errors from mqtt.js or Node may contain
URLs, hostnames or credentials.

## Decision

- A single base class `MqttIntelligenceError` with a **stable string `code`**, a `retryable`
  flag, safe `details` (primitives only) and an optional `cause` kept for logs.
- Subclasses: `ConfigError`, `BrokerError`, `PolicyError`, `ValidationError`,
  `NotFoundError`, `OperationError`, `InternalError`, with the codes listed in the
  architecture document (`BROKER_AMBIGUOUS`, `ACCESS_DENIED`, `TOPIC_NOT_OBSERVED`, …).
- Every external error is wrapped and **sanitized** at the adapter boundary (URL userinfo
  removed, secrets masked).
- The core throws; it does not return `Result` objects. Adapters map errors:
  - MCP: domain errors become tool results with `isError: true` and a text of the form
    `CODE: message. Hint: …`; `InternalError` returns only a correlation id, details are
    logged.
- Error codes are part of the public API under semver.

## Consequences

- Positive: agents receive actionable, safe errors; library users can switch on `code`.
- Negative: discipline required to wrap every external error; enforced by tests that assert
  no raw error escapes the engine.

## Alternatives considered

- **Result/Either types throughout:** explicit but verbose and unidiomatic for most
  TypeScript users of a library.
- **Plain `Error` messages:** not machine-readable, easy to leak secrets.

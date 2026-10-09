# ADR-0003 — Core independent from MCP (ports and adapters)

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

MCP evolves quickly (spec revisions 2025-06-18, 2025-11-25, 2026-07-28; SDK v2 with breaking
changes in July 2026). The engine must also be usable from a CLI, a REST API or directly as a
library. Testability requires replacing I/O (MQTT, storage, time) with fakes.

## Decision

- `core` has **no dependency on any MCP package**. Its public surface is the `Engine` facade
  returned by `createEngine(config, deps)`.
- Everything with I/O or time is a **port** in `core`: `MqttTransport`, `TopicCatalog`,
  `MessageStore`, `Clock`, `Logger`, `MetricsRecorder`. Default adapters also live in `core`
  (`transport/mqttjs`, `store/memory`, system clock, stderr JSON logger, no-op metrics).
- The MCP package is an adapter: validation, clamping, rendering and error mapping only. It
  calls nothing but `Engine`.
- Cancellation and progress cross the boundary as a standard `AbortSignal` and a plain
  `onProgress` callback.

## Consequences

- Positive: MCP churn stays in one package; a future CLI or REST adapter reuses the whole
  engine.
- Positive: deterministic tests with `FakeTransport` and `FakeClock`.
- Negative: some duplication between core types and MCP output schemas (zod). Mitigated by
  defining each tool's output schema once, next to its renderer, and testing it against the
  core types.

## Alternatives considered

- **MCP-first design** (tools as the core API): fastest to demo, but couples every feature to
  one protocol and to its SDK's breaking changes.

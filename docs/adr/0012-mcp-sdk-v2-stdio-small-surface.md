# ADR-0012 — MCP SDK v2, stdio only in V0.1, small tool surface

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

- The MCP TypeScript SDK v2 (2026-07-27) is split into packages; servers depend on
  `@modelcontextprotocol/server` (Zod v4, Node ≥ 20). v1 (`@modelcontextprotocol/sdk`) only
  receives fixes.
- Spec 2026-07-28 is stateless (no session, no `initialize`), moves tasks to an extension
  that SDK v2 does not implement, and deprecates MCP logging, sampling and roots.
- Many clients time out tool calls after about 60 seconds.
- Every tool definition costs context tokens and dilutes tool selection accuracy.
- A network transport without authentication would expose broker data to the network.

## Decision

- Depend on **`@modelcontextprotocol/server@^2`**; use `McpServer.registerTool` with Zod v4
  input and output schemas, `structuredContent` plus a compact text rendering, and tool
  annotations (`readOnlyHint`, `idempotentHint`, `openWorldHint`; `destructiveHint` for
  publish later).
- **stdio only** in V0.1 (`serveStdio`). Streamable HTTP arrives in V0.5 together with
  authentication (bearer tokens verified through the SDK's resource-server helpers) and
  host/origin validation. Never before.
- Server-side state across calls uses **explicit handles** (e.g. `captureId` in V0.3), which
  is the idiomatic pattern for the stateless spec. No dependency on SDK tasks.
- Long operations are bounded, report progress (`progressToken`) and honour cancellation
  (`ctx.mcpReq.signal`).
- No use of MCP logging, sampling or roots.
- **Tool budget:** 6 tools in V0.1, about 11 at V1. Adding a tool requires showing that
  extending an existing tool would be worse.
- Tool names, input schemas, output schemas and error codes are a **public API** under
  semver; before 1.0, breaking changes are listed in the changelog.

## Consequences

- Positive: aligned with the current spec and SDK; no dependency on deprecated features.
- Negative: SDK v2 is recent (no patch release yet at the time of writing); we pin a caret
  range and track releases with Renovate/Dependabot. Host support for spec 2026-07-28 is
  still rolling out; `serveStdio` also serves 2025-era clients.

## Alternatives considered

- **SDK v1:** stable and widely used, but in maintenance mode; migrating later costs more
  than starting on v2.
- **HTTP transport in V0.1:** attractive for remote deployments, unacceptable without
  authentication.
- **One tool per micro-operation:** easier to write, harder for agents to use.

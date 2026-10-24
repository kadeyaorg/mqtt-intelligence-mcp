# ADR-0002 — Monorepo with two published packages and a modular core

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

The initial brief proposed ten packages (core, mqtt-adapter, discovery, analyzer,
schema-inference, timeline, security, storage, mcp-server, cli). Every published package is a
public API with its own version, changelog and compatibility promise. Discovery, analysis,
schema inference and timelines all operate on the same models and have no independent
consumers.

## Decision

- One repository (npm workspaces) with **two published packages** in V0.1:
  - `@kadeya/mqtt-intelligence-core`: the engine, as a library;
  - `@kadeya/mqtt-intelligence-mcp`: the MCP server and the `npx` entry point.

  Naming: every package of the project shares the `mqtt-intelligence-` prefix, so the family
  stays recognisable inside the `@kadeya` scope. Future packages follow the same pattern
  (e.g. `@kadeya/mqtt-intelligence-store-sqlite`, `@kadeya/mqtt-intelligence-sparkplug`). The
  project name stays **MQTT Intelligence MCP**.

  Repository: `github.com/kadeyaorg/mqtt-intelligence-mcp`, public since 2026-10-23. The
  `@kadeya` npm organisation was created on the same day. Both packages carried
  `"private": true` until the pull request that released them.

### Amended 2026-10-24 — the abbreviation goes

Both names abbreviated `intelligence` to its first five letters until the day before the
first publication, chosen because short names are easier to type and to remember. They were
spelled out in full because that abbreviation, on a public registry, reads as a processor
manufacturer's trademark — and a package family that borrows a well-defended mark is not
worth the characters it saves. The rename reached 62 files and cost nothing, because nothing
had been published; after publication it would have cost the names themselves.

The same abbreviation was the default MQTT client id prefix, sent to every broker and visible
in its logs. It became `mqtt-observer`, not `mqtt-intelligence`: the full name would give
`mqtt-intelligence-<8 hex>`, 26 characters, above the 23 that MQTT 3.1 imposed and that a
3.1.1 broker is still free to enforce. `mqtt-observer-<8 hex>` is 22, and it says what the
client does — it watches, it cannot publish.

A test refuses the abbreviation anywhere in the repository, so it cannot come back through a
distracted pull request.

- Inside `core`, the modules (`domain`, `config`, `payload`, `policy`, `transport`, `broker`,
  `subscription`, `ingest`, `catalog`, `store`, `discovery`, `query`, `observability`) have
  **enforced dependency rules**: a local ESLint rule checks the module dependency table, and
  `no-restricted-imports` keeps `mqtt` and MCP packages out of the wrong places (ADR-0016).
- A module is extracted into its own package only when it gains an independent consumer or
  an independent dependency, e.g. `store-sqlite`, `store-redis`, `store-postgres`,
  `sparkplug`, `otel`, `cli` (each published as `@kadeya/mqtt-intelligence-<name>`).
- `core` exposes a `./testing` subpath with fakes and the storage contract test suite.

## Consequences

- Positive: two public APIs to keep stable instead of ten; refactoring across modules stays
  cheap while the design settles.
- Positive: optional heavy dependencies (database drivers, protobuf, OTel SDK) never end up
  in the default install.
- Negative: boundaries rely on lint rules rather than on package manifests; CI must run lint.

## Alternatives considered

- **Ten packages from the start:** premature API surface and versioning overhead.
- **Single package:** would force storage drivers and plugins into the default install and
  prevent using the engine without MCP dependencies.

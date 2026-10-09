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
  - `@kadeya/mqtt-intel-core`: the engine, as a library;
  - `@kadeya/mqtt-intel-mcp`: the MCP server and the `npx` entry point.

  Naming: package names are short, and every package of the project shares the
  `mqtt-intel-` prefix, so the family stays recognisable inside the `@kadeya` scope. Future
  packages follow the same pattern (e.g. `@kadeya/mqtt-intel-store-sqlite`,
  `@kadeya/mqtt-intel-sparkplug`). The project name stays **MQTT Intelligence MCP**.

  Repository: `github.com/kadeyaorg/mqtt-intelligence-mcp` (confirmed, private for now).
  The `@kadeya` npm scope is still **to be confirmed** (npm organisation not created yet).
  Both packages stay `"private": true` until the first release, so nothing can be
  published by accident.

- Inside `core`, the modules (`domain`, `config`, `payload`, `policy`, `transport`, `broker`,
  `subscription`, `ingest`, `catalog`, `store`, `discovery`, `query`, `observability`) have
  **enforced dependency rules**: a local ESLint rule checks the module dependency table, and
  `no-restricted-imports` keeps `mqtt` and MCP packages out of the wrong places (ADR-0016).
- A module is extracted into its own package only when it gains an independent consumer or
  an independent dependency, e.g. `store-sqlite`, `store-redis`, `store-postgres`,
  `sparkplug`, `otel`, `cli` (each published as `@kadeya/mqtt-intel-<name>`).
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

# MQTT Intelligence MCP

> **Pre-release. Not ready for use.** Nothing is published to npm yet. The project is being
> built step by step following the [implementation plan](docs/proposal/05-implementation-plan.md).

Give AI agents safe, structured and observable access to MQTT infrastructures.

MQTT Intelligence MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server
and a Node.js library. It lets agents explore, understand and diagnose MQTT namespaces:
topic discovery, a bounded topic catalog, safe payload views, and explicit statements of
what the engine could and could not observe. It is **read-only by default**.

## Design

- [Architecture proposal](docs/proposal/README.md): analysis, ecosystem review,
  architecture, V0.1 scope and implementation plan.
- [Architecture Decision Records](docs/adr/README.md).

## Repository layout

| Path                  | Content                                                |
| --------------------- | ------------------------------------------------------ |
| `packages/core`       | `@kadeya/mqtt-intel-core`: the engine, as a library    |
| `packages/mcp-server` | `@kadeya/mqtt-intel-mcp`: the MCP server and CLI       |
| `tools/eslint`        | Local lint rule enforcing the core's module boundaries |
| `docs`                | Architecture proposal and ADRs                         |

The `@kadeya` npm scope is not confirmed yet, and both packages are marked private: nothing
can be published until the first release.

## Development

Requirements: Node.js 22 (≥ 22.13) or 24. See [`.nvmrc`](.nvmrc).

```bash
npm ci
npm run check
```

`npm run check` runs, in order: `build`, `typecheck`, `lint`, `format:check` and `test`.
Each script can also be run on its own.

## Supported Node.js versions

Only Node.js LTS lines are supported: currently **22** and **24**. Node 26 is tested in CI
as experimental and becomes supported when it enters LTS (see
[ADR-0001](docs/adr/0001-typescript-on-node-lts.md)).

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).

# Changelog

This repository publishes two packages, and each keeps its own changelog — a version number
means something only for the package it belongs to.

- [`@kadeya/mqtt-intelligence-core`](packages/core/CHANGELOG.md) — the engine
- [`@kadeya/mqtt-intelligence-mcp`](packages/mcp-server/CHANGELOG.md) — the MCP server and the CLI

Those files are written by [Changesets](https://github.com/changesets/changesets) at release
time, from the notes added alongside each change. Nothing has been released yet; see
[docs/releasing.md](docs/releasing.md) for what is still open before the first one, and
[GitHub releases](https://github.com/kadeyaorg/mqtt-intelligence-mcp/releases) once there are
some.

## What counts as a breaking change

Before 1.0, the public surface is the MCP tool names and their schemas, the error codes, the
CLI exit codes, the configuration schema, and the exports of both packages. A change to any of
them is a minor bump and says so in capitals at the top of its entry.

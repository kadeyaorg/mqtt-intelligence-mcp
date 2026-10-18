# Documentation

| Document                             | For                                                                |
| ------------------------------------ | ------------------------------------------------------------------ |
| [architecture.md](architecture.md)   | How it is put together, and the three ideas that shape it          |
| [mcp-tools.md](mcp-tools.md)         | The six tools: inputs, outputs, errors, and the answer envelope    |
| [configuration.md](configuration.md) | Every key in the configuration file, and the ones that matter      |
| [security.md](security.md)           | The security model and the threat model, including its limits      |
| [observability.md](observability.md) | Logs, metrics, and the counters that say when we dropped something |
| [releasing.md](releasing.md)         | How a release is cut, and what is still open before the first one  |

## Decisions and design

| Document                        | For                                                                 |
| ------------------------------- | ------------------------------------------------------------------- |
| [adr/](adr/README.md)           | Eighteen decisions, each with the alternatives that were rejected   |
| [proposal/](proposal/README.md) | The design document: analysis, ecosystem, architecture, scope, plan |

An ADR is immutable once accepted. A decision that changes gets a new ADR that supersedes the
old one, so the reasoning behind what was abandoned stays readable.

## Elsewhere in the repository

- [examples/](../examples/README.md) — a fictional factory, five configurations, four MCP clients
- [skills/mqtt-investigation/](../skills/mqtt-investigation/README.md) — how an agent should use the six tools, and the capture script for what they cannot do
- [CONTRIBUTING.md](../CONTRIBUTING.md) — how to work on this, and what a reviewer looks for
- [SECURITY.md](../SECURITY.md) — reporting a vulnerability

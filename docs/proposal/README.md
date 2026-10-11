# Architecture proposal — MQTT Intelligence MCP

> Status: **Approved on 2026-09-18.** Implementation follows [05-implementation-plan.md](05-implementation-plan.md). Where this proposal and the [ADRs](../adr/README.md) differ, the ADRs prevail.

| #   | Document                                         | Content                                                                                                                                                                                        |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | [Analysis](01-analysis.md)                       | Review of the brief: good decisions, problems, technical, security and scalability risks, over-engineering, gaps, roadmap challenge                                                            |
| 02  | [Ecosystem](02-ecosystem.md)                     | MCP TypeScript SDK v2 and spec 2026-07-28, mqtt.js 5.16, Node LTS, existing MQTT MCP servers, differentiation                                                                                  |
| 03  | [Architecture](03-architecture.md)               | Packages, modules, dependencies, public API, data model, configuration, errors, broker and subscription lifecycles, ingestion, storage, security boundaries, MCP layer, observability, testing |
| —   | [ADRs](../adr/README.md)                         | 18 Architecture Decision Records                                                                                                                                                               |
| 04  | [Scope V0.1](04-scope-v0.1.md)                   | In/out of scope, acceptance criteria, revised roadmap                                                                                                                                          |
| 05  | [Implementation plan](05-implementation-plan.md) | 15 incremental, verifiable steps and the decisions needed before starting                                                                                                                      |

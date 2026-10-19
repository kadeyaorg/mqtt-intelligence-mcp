# Architecture Decision Records

We record structurally significant decisions as ADRs
([Michael Nygard's format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)).
An ADR is immutable once **Accepted**; changing a decision means writing a new ADR that
supersedes the old one.

Statuses: `Proposed` → `Accepted` | `Rejected`; later `Deprecated` or `Superseded by ADR-XXXX`.

| ADR                                                   | Title                                                                 | Status   |
| ----------------------------------------------------- | --------------------------------------------------------------------- | -------- |
| [0001](0001-typescript-on-node-lts.md)                | TypeScript (strict, ESM) on Node.js LTS                               | Accepted |
| [0002](0002-monorepo-with-two-packages.md)            | Monorepo with two published packages and a modular core               | Accepted |
| [0003](0003-core-independent-from-mcp.md)             | Core independent from MCP (ports and adapters)                        | Accepted |
| [0004](0004-read-only-by-default.md)                  | Read-only by default; one policy engine with deny precedence          | Accepted |
| [0005](0005-multi-broker.md)                          | Multi-broker as a first-class dimension                               | Accepted |
| [0006](0006-mqttjs-behind-transport-port.md)          | mqtt.js behind a transport port; own reconnection and resubscription  | Accepted |
| [0007](0007-passive-discovery.md)                     | Passive discovery with explicit observation coverage                  | Accepted |
| [0008](0008-storage-ports.md)                         | Separate TopicCatalog and MessageStore ports; in-memory first         | Accepted |
| [0009](0009-bounded-ingestion.md)                     | Bounded ingestion: count everything, inspect a sample, drop and count | Accepted |
| [0010](0010-payload-classification-and-safe-views.md) | Payload classification and LLM-safe payload views                     | Accepted |
| [0011](0011-facts-observations-limitations.md)        | Facts, observations and limitations in every answer                   | Accepted |
| [0012](0012-mcp-sdk-v2-stdio-small-surface.md)        | MCP SDK v2, stdio only in V0.1, small tool surface                    | Accepted |
| [0013](0013-configuration-and-secrets.md)             | YAML configuration validated by zod; secrets by reference             | Accepted |
| [0014](0014-typed-errors-with-stable-codes.md)        | Typed errors with stable codes                                        | Accepted |
| [0015](0015-observability-ports.md)                   | Observability through logger and metrics ports, OTel-aligned          | Accepted |
| [0016](0016-toolchain.md)                             | Toolchain: npm workspaces, tsc, Vitest, ESLint, Testcontainers        | Accepted |
| [0017](0017-license.md)                               | Apache-2.0 license                                                    | Accepted |
| [0018](0018-cli-contract.md)                          | The CLI writes to stderr; exit codes are part of the contract         | Accepted |
| [0019](0019-schema-as-counts.md)                      | An inferred schema is counts, and a wide object is a map              | Accepted |
| [0020](0020-activity-is-a-filter.md)                  | Activity is a filter on search, not a tool of its own                 | Accepted |

New ADRs: copy [template.md](template.md).

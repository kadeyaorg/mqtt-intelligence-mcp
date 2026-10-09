# ADR-0016 — Toolchain: npm workspaces, tsc, Vitest, ESLint, Testcontainers

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

The toolchain must be familiar to contributors, run on Linux, macOS and Windows, and keep
the number of moving parts low. Development dependencies do not ship to users, but every
tool is a maintenance cost.

## Decision

| Concern           | Choice                                                                                                                                                                           | Rationale                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspaces        | **npm workspaces**                                                                                                                                                               | Built into Node; two packages do not justify pnpm/Nx/Turborepo.                                                                                    |
| Compiler          | **TypeScript 6.0.x**                                                                                                                                                             | TypeScript 7 (native compiler) is released, but typescript-eslint supports only `<6.1.0` so far. We move to 7 once the lint toolchain supports it. |
| Build             | **`tsc -b`** with project references                                                                                                                                             | No bundler needed for a Node library; accurate declarations.                                                                                       |
| Tests             | **Vitest**                                                                                                                                                                       | Mature TypeScript support, fake timers, coverage, workspace projects.                                                                              |
| Property tests    | **fast-check**                                                                                                                                                                   | Topic matching and statistics merging have large input spaces.                                                                                     |
| Integration       | **Testcontainers** (Eclipse Mosquitto; EMQX, HiveMQ CE, NanoMQ nightly)                                                                                                          | Real brokers, restartable for reconnection tests, same setup locally and in CI.                                                                    |
| Lint              | **ESLint** (flat config) + **typescript-eslint** `strictTypeChecked`                                                                                                             | Type-aware rules such as `no-floating-promises` are essential for async MQTT code.                                                                 |
| Module boundaries | A **local ESLint rule** (`tools/eslint`) that checks core's module dependency table (ADR-0002), plus `no-restricted-imports` for `mqtt`, MCP packages and deep imports of `core` | Exact checks without adding a plugin dependency. The rule has its own tests.                                                                       |
| Format            | **Prettier**                                                                                                                                                                     | Standard.                                                                                                                                          |
| Versioning        | **Changesets**                                                                                                                                                                   | Per-package changelogs and coordinated releases.                                                                                                   |
| Releases          | GitHub Actions, **npm provenance**                                                                                                                                               | Supply-chain transparency.                                                                                                                         |
| Dependencies      | **Dependabot** (npm and GitHub Actions); CodeQL; OpenSSF Scorecard (with release work)                                                                                           | Security hygiene expected by enterprises. Dependabot is built into GitHub; no app to install.                                                      |
| Action pinning    | Third-party GitHub Actions pinned by **commit SHA**, with the version in a comment                                                                                               | Supply-chain hardening (Scorecard "Pinned-Dependencies"); Dependabot keeps them current.                                                           |
| CI matrix         | See below                                                                                                                                                                        | Industrial users often run Windows.                                                                                                                |

**CI matrix** (policy in ADR-0001):

| Job                                      | OS                     | Node                         | Blocking |
| ---------------------------------------- | ---------------------- | ---------------------------- | -------- |
| Quality (build, typecheck, lint, format) | Ubuntu                 | 24                           | yes      |
| Unit tests                               | Ubuntu, Windows, macOS | 22, 24 (supported LTS lines) | yes      |
| Unit tests, experimental                 | Ubuntu                 | 26 (current, not yet LTS)    | **no**   |
| Integration tests (added in step 6)      | Ubuntu                 | 22, 24                       | yes      |

Node 26 moves to the blocking rows when it enters LTS (2026-10-28). Node 22 leaves them
at its end of life (2027-04-30).

## Consequences

- Positive: conventional, contributor-friendly stack; quick CI.
- Negative: Vitest and ESLint bring sizeable development dependency trees (not shipped).
- Integration tests require Docker; they are skipped with a clear message when Docker is
  unavailable locally, and always run in CI.

## Alternatives considered

- **`node:test`:** native and dependency-free, but weaker ergonomics for coverage, fake
  timers across modules and workspace runs. Could be revisited.
- **Biome instead of ESLint + Prettier:** faster, single tool, but less complete type-aware
  linting.
- **pnpm:** stricter dependency isolation; not needed at this size.
- **GitHub Actions `services:` instead of Testcontainers:** no restart control for
  reconnection tests and no local parity.

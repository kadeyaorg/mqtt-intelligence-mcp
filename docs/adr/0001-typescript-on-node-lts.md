# ADR-0001 — TypeScript (strict, ESM) on Node.js LTS

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

The project targets developers, integrators and enterprises. It must be easy to install
(`npx`), easy to embed as a library, and trustworthy to review. The official MCP SDK and the
reference MQTT client for Node.js (mqtt.js) are both TypeScript/JavaScript. As of
2026-09-18, Node 20 is end-of-life, Node 22 is in maintenance LTS until 2027-04-30, Node 24
is active LTS and Node 26 becomes LTS on 2026-10-28. The MCP SDK v2 requires Node ≥ 20.

## Decision

- Language: **TypeScript** with `strict: true` plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`,
  `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `isolatedModules`.
- Modules: **ESM only** (`"type": "module"`, `module`/`moduleResolution: "NodeNext"`).
  mqtt.js, which is CommonJS in Node, is consumed through Node's CJS interop.
- Runtime: **only Node.js LTS lines are officially supported.** On 2026-09-18 these are
  **Node 22** (maintenance LTS) and **Node 24** (active LTS); `engines.node` is
  `^22.12.0 || >=24.0.0`.
- CI tests every supported LTS line as a **blocking** job. The current non-LTS line
  (Node 26 today) runs as an **experimental, non-blocking** job to get early warnings. It is
  not advertised as supported.
- Support matrix lifecycle:
  - a line is **promoted** to supported (blocking CI, README, docs) when it enters LTS
    (Node 26 on 2026-10-28), through a normal pull request;
  - a line is **dropped** once it reaches end of life (Node 22 on 2027-04-30), announced in
    the changelog.
- `any` is forbidden by lint (`@typescript-eslint/no-explicit-any`, `no-unsafe-*`);
  external data enters as `unknown` and is narrowed by schemas.
- Published output: compiled JavaScript + declaration files + declaration maps. No bundler.

## Consequences

- Positive: one language across core, MCP adapter, examples and tests; types are the first
  line of documentation for library users.
- Positive: ESM-only avoids the dual-package hazard.
- Negative: CJS-only consumers must use `import()` (or `require(esm)`, unflagged from
  Node 22.12).
- The `engines` range deliberately does not block newer, not-yet-LTS Node versions from
  installing; "supported" means tested in blocking CI and covered by bug fixes.
- Someone must promote and drop Node lines on schedule. The dates are listed in this ADR
  and in the CI workflow comments.

## Alternatives considered

- **Go / Rust single binary:** better raw throughput, but diverges from the MCP TypeScript
  SDK and from the npm-based tooling MCP users already have.
- **Python:** most existing MQTT MCP servers are Python; a TypeScript engine installable with
  `npx` is itself a differentiator.
- **Dual ESM/CJS publishing:** extra build complexity for a shrinking audience.

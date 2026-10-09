# ADR-0017 — Apache-2.0 license

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Kadeya

## Context

The project will be published by a company, used as a technical showcase and potentially
adopted by large enterprises whose legal teams review licenses. Our main runtime
dependencies are MIT (mqtt.js, zod, yaml) and MIT/Apache-compatible (MCP SDK).

## Decision

- License: **Apache License 2.0**. The root `LICENSE` file is the unmodified standard text
  (the one GitHub added when the repository was created).
- A root **`NOTICE`** file names the copyright holder: **Kadeya Inc. (Automated Water
  Machines, Inc.)** (GitHub: `kadeyaorg`).
- In the code base, the holder's name appears **only in `NOTICE`**, so it can be corrected in
  one place. Source files carry no copyright headers.
- Contributions are accepted under the same license with a **DCO** sign-off
  (`Signed-off-by:` trailer, `git commit -s`). There is **no CLA**. The DCO check and
  CONTRIBUTING instructions come with the community files (implementation plan, step 14).
- Published packages will include `LICENSE` and `NOTICE` (added to each package at release
  time; nothing is published before the npm organisation is confirmed).

## Consequences

- Positive: explicit patent grant and patent-retaliation clause, which enterprise legal
  teams favour; compatible with our dependencies; widely used in industrial and cloud
  open source (for example Eclipse and CNCF projects).
- Positive: DCO keeps contribution friction low.
- Negative: slightly longer license text and a NOTICE file to maintain.

## Alternatives considered

- **MIT:** simpler and very common, but no explicit patent grant.
- **EPL-2.0:** common in the Eclipse IoT ecosystem, but weak copyleft complicates embedding
  for some enterprises.
- **AGPL / source-available:** incompatible with the adoption goal.

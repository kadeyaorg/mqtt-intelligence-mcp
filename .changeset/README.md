# Changesets

A changeset is a short note describing a change a user would notice, and how it should move
the version. `npx changeset` writes one; the files here are collected into the changelog and
the version bump at release time.

Documentation, tests and internal refactors need none.

Write the line for the person reading the changelog, not for the person who wrote the patch:
"topic search no longer drops the last page" rather than "fix cursor off-by-one".

[How this repository releases](../docs/releasing.md).

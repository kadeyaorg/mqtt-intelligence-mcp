# Releasing

Releases are **manual**. Nothing in this repository can publish to npm because somebody merged
a pull request: a release is a decision, and it is taken by a person, in the Actions tab.

## Before the first release

Two things are still open, and the first release cannot happen without them:

1. **The `@kadeya` npm organisation** must exist, and `NPM_TOKEN` must be a repository secret
   with publish rights to it. The scope was chosen in
   [ADR-0002](adr/0002-monorepo-with-two-packages.md) and is marked provisional there.
2. **Both packages carry `"private": true`.** That is deliberate — nothing can be published by
   accident — and it must be flipped to `false` in `packages/core/package.json` and
   `packages/mcp-server/package.json` in the same pull request as the first release. The
   release workflow refuses to publish while either is private, and says which one.

## The cycle

### 1. Changesets, as the work happens

A change a user would notice gets a changeset in its own pull request:

```bash
npx changeset
```

Pick the packages, pick the bump, write the line that will appear in the changelog — for the
person reading it, not the person who wrote the patch. Documentation, tests and internal
refactors need none.

Pre-1.0, a breaking change is a **minor** bump and must say so in capitals at the top of its
changeset.

### 2. Version

Actions → **Release** → Run workflow → `version`.

It collects the changesets, bumps the versions, writes `CHANGELOG.md` in each package,
refreshes the lockfile, and opens a `release/vX.Y.Z` pull request.

Read that pull request. The changelog is the thing most users will read about this project
after the README; if an entry does not make sense to someone who has not seen the diff, fix it
there.

### 3. Merge

Normal review, squash merge, CI green.

### 4. Publish

Actions → **Release** → Run workflow → `publish`, on `main`.

It refuses if a package is still private, or if changesets are still pending. Then it runs
`npm run check` and the integration tests again — on exactly what will be published — publishes
both packages with **npm provenance**, tags `vX.Y.Z`, and creates a GitHub release from that
version's changelog section.

Provenance means npm records which workflow, from which commit, built the tarball, and shows a
verified badge on the package page. It needs `id-token: write`, which the workflow has, and
`publishConfig.provenance` in each package, which they have.

### 5. Afterwards

- Check both packages on npm: the files list, the README, the provenance badge.
- `npx @kadeya/mqtt-intel-mcp check --config examples/industrial-machine/mqtt-intelligence.yaml`
  against the example stack, from a directory that is not this repository. That is the quick
  start a new user runs, and it is the one thing the test suite cannot check.
- Announce it where it is useful, not everywhere.

## Version policy

Pre-1.0 the public API is the tool names and their schemas, the error codes, the CLI exit
codes, the configuration schema, and the exports of both packages. Changing any of them is a
minor bump and a prominent changelog entry.

At 1.0 those come under semver proper ([ADR-0002](adr/0002-monorepo-with-two-packages.md)).

## Node.js support

Only LTS lines ([ADR-0001](adr/0001-typescript-on-node-lts.md)). A release's `engines` field
and the CI matrix must agree, and a Node line is added to the blocking matrix only once it
enters LTS — it may run as a non-blocking experimental job before that.

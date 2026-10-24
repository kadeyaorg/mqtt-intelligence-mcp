# Releasing

Releases are **manual**. Nothing in this repository can publish to npm because somebody merged
a pull request: a release is a decision, and it is taken by a person, in the Actions tab.

## Before the first release

The `@kadeya` organisation exists on npm, the repository is public, and both packages are out
of their `"private": true` safety catch. **One thing is still open.**

**The first publish needs a token, and only the first.** A trusted publisher is configured per
package, and npm cannot configure one for a package that does not exist yet. So: create a
granular access token scoped to `@kadeya/*` with the shortest expiry npm offers, store it as
the `NPM_TOKEN` repository secret, run the release, then **revoke the token and delete the
secret**. From the second release on, see [Trusted publishing](#trusted-publishing).

Two things that are no longer open, because the release depends on them staying that way:

- **The repository is public.** npm refuses a provenance attestation that points at a private
  source repository, and it refuses it with a 422 _after_ the tarball has been uploaded — a
  failed release rather than a clean refusal. The publish job asks the API before anything
  leaves the runner, so turning the repository private again fails the release early and says
  so. The alternative then is `publishConfig.provenance: false` in both packages, and no badge.
- **Both packages are publishable.** `"private": true` was the catch that made an accidental
  publish impossible; the pull request that opened the registry removed it from both at once.
  `tools/packaging/manifests.test.js` refuses a change that touches only one of them, because
  one published package whose peer is still private is a package nobody can install.

The scope was chosen in [ADR-0002](adr/0002-monorepo-with-two-packages.md), where it is marked
provisional.

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

It refuses if a package is still private, if changesets are still pending, or if the repository
is private while the packages ask for provenance. Then it runs `npm run check` and the
integration tests again — on exactly what will be published — publishes both packages with
**npm provenance**, tags `vX.Y.Z`, and creates a GitHub release from that version's changelog
section.

Provenance means npm records which workflow, from which commit, built the tarball, and shows a
verified badge on the package page. It needs `id-token: write`, which the workflow has,
`publishConfig.provenance` in each package, which they have, a `repository` field that matches
the workflow's own repository, which the packaging test checks, and a **public** repository.

### 5. Afterwards

- Check both packages on npm: the files list, the README, the provenance badge.
- `npx @kadeya/mqtt-intelligence-mcp check --config examples/industrial-machine/mqtt-intelligence.yaml`
  against the example stack, from a directory that is not this repository. That is the quick
  start a new user runs, and it is the one thing the test suite cannot check.
- Announce it where it is useful, not everywhere.

## Trusted publishing

npm revoked all classic tokens on 2025-12-09, and a long-lived automation token sitting in a
repository secret is the most valuable thing in a release pipeline to steal. Once both packages
exist on the registry, replace it with OIDC:

1. On npmjs.com, for each package: Settings → Trusted publisher → GitHub Actions, with the
   repository `kadeyaorg/mqtt-intelligence-mcp` and the workflow `release.yml`.
2. Set each package to require its trusted publisher, so no token can publish it any more.
3. Remove the `NODE_AUTH_TOKEN` environment from the Publish step of
   [`release.yml`](../.github/workflows/release.yml), and delete the `NPM_TOKEN` secret.

The workflow already has the `id-token: write` permission the exchange needs, and the npm that
ships with the pinned Node line is new enough — trusted publishing needs npm 11.5.1 or later.
Nothing else about the release changes: `npm run release` uses the short-lived token it gets
from the exchange instead of reading a secret.

## Version policy

Pre-1.0 the public API is the tool names and their schemas, the error codes, the CLI exit
codes, the configuration schema, and the exports of both packages. Changing any of them is a
minor bump and a prominent changelog entry.

At 1.0 those come under semver proper ([ADR-0002](adr/0002-monorepo-with-two-packages.md)).

## Node.js support

Only LTS lines ([ADR-0001](adr/0001-typescript-on-node-lts.md)). A release's `engines` field
and the CI matrix must agree, and a Node line is added to the blocking matrix only once it
enters LTS — it may run as a non-blocking experimental job before that.

# Releasing

Releases are **manual**. Nothing in this repository can publish to npm because somebody merged
a pull request: a release is a decision, and it is taken by a person, in the Actions tab.

## How a release authenticates

**There is no publishing credential in this repository.** Both packages are configured on
npmjs.com to accept a trusted publisher — this repository, this workflow file — and to refuse
a token-based publish outright. The publish job exchanges its OIDC identity for a short-lived
token that exists for the length of the run.

What that depends on, and what breaks it:

- **`id-token: write` on the publish job.** It is the whole credential now. Removing it does
  not fall back to anything.
- **npm 11.5.1 or newer**, which is what performs the exchange. The supported Node lines are
  not equal here: 26 ships npm 11.20, 24 ships 11.19, **22 ships 10.9**. The job checks before
  it publishes and says what it found.
- **A public repository.** npm refuses a provenance attestation pointing at a private source
  repository, with a 422 _after_ the tarball has been uploaded. The job asks the API first, so
  making this repository private again fails the release early and says why. The alternative
  then is `publishConfig.provenance: false` in both packages, and no badge.
- **Both packages publishable.** `"private": true` was the catch that made an accidental
  publish impossible before the first release. `tools/packaging/manifests.test.js` refuses a
  change that puts it back on only one of them: one published package whose peer is private is
  a package nobody can install.

`tools/workflows/release.test.js` holds the first two and refuses a publish token reappearing
in the workflow, because a token now grants nothing and would only produce a release that
fails for a reason nobody expects.

If the trusted publisher ever has to be rebuilt — npm fixes the provider and repository when
the connection is created — delete it and make a new one, per package: GitHub Actions,
`kadeyaorg` / `mqtt-intelligence-mcp`, workflow `release.yml`, no environment, and **Allow
npm `publish`** ticked. Without that last one only `npm stage publish` is permitted, and
`changeset publish` calls `npm publish`. The repository field is the **monorepo** for both
packages, not the package's own name.

The scope was chosen in [ADR-0002](adr/0002-monorepo-with-two-packages.md), which also records
why the names are spelled out in full.

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
refreshes the lockfile, commits, and pushes `release/vX.Y.Z`.

**Then it fails, and that is expected.** Its last action is `gh pr create`, which GitHub
refuses:

```
GitHub Actions is not permitted to create or approve pull requests (createPullRequest)
```

The job's `pull-requests: write` permission is not enough; a separate repository setting gates
it — Settings → Actions → General → Workflow permissions → _Allow GitHub Actions to create and
approve pull requests_ — and it is deliberately left off. Actions being able to open pull
requests is a power this repository has no need for, and the cost of leaving it off is that
you open the release pull request yourself. The push output prints the link.

Everything before that step succeeded, so do not dispatch `version` again: it would try to
collect changesets that no longer exist.

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

## How this came to be tokenless

The first release, 0.2.0 on 2026-10-24, could not use a trusted publisher: npm configures one
per package, and it cannot configure one for a package that does not exist. So it went out
with a granular access token scoped to `@kadeya/*`, which was revoked and deleted immediately
afterwards, and the packages were then set to require their trusted publisher.

That is the general shape for any new package in this scope: one short-lived token for the
first version, then OIDC and nothing stored. npm revoked all classic tokens on 2025-12-09 and
is removing direct publishing with granular tokens in January 2027, so a token is a bridge and
never a destination.

## Version policy

Pre-1.0 the public API is the tool names and their schemas, the error codes, the CLI exit
codes, the configuration schema, and the exports of both packages. Changing any of them is a
minor bump and a prominent changelog entry.

At 1.0 those come under semver proper ([ADR-0002](adr/0002-monorepo-with-two-packages.md)).

## Node.js support

Only LTS lines ([ADR-0001](adr/0001-typescript-on-node-lts.md)). A release's `engines` field
and the CI matrix must agree, and a Node line is added to the blocking matrix only once it
enters LTS — it may run as a non-blocking experimental job before that.

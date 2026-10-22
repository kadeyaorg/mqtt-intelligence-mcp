# Contributing

Thank you for considering it. This document is short on purpose: the parts that matter are
the sign-off, the checks, and what a reviewer will look for.

## Before a large change

Open an issue first. An architectural change is a conversation, not a pull request — and this
repository records its decisions as [ADRs](docs/adr/README.md), so a change that contradicts
one needs a new ADR rather than a quiet edit to the old one.

Small fixes, documentation and tests need no preamble.

## Getting set up

Node.js 22 (≥ 22.13), 24 or 26. Only LTS lines are supported
([ADR-0001](docs/adr/0001-typescript-on-node-lts.md)); `.nvmrc` pins the one CI uses.

```bash
npm ci
npm run check
```

`npm run check` runs, in order: `build`, `typecheck`, `lint`, `format:check`, `test`. It is
what CI runs, so a green `check` locally means a green CI — except for the integration tests,
which need Docker:

```bash
npm run test:integration
```

Those start a real Mosquitto through Testcontainers and the published example stack through
Docker Compose. They are slower, they are excluded from `npm test`, and they are the ones
that catch what fakes cannot.

`npm install` points git at [`.githooks`](.githooks), where a `pre-push` hook refuses a direct
push to `main`. Set `ALLOW_PUSH_TO_MAIN=1` if you genuinely need to override it.

## The sign-off

Every commit needs a [Developer Certificate of Origin](https://developercertificate.org/)
sign-off. It is one line, added by `-s`:

```bash
git commit -s -m "fix(core): …"
```

which appends `Signed-off-by: Your Name <your@email>`. By adding it you state that you wrote
the patch, or have the right to submit it under this project's licence. There is **no CLA**:
you keep the copyright to your contribution ([ADR-0017](docs/adr/0017-license.md)).

Forgot it on the last commit: `git commit --amend -s --no-edit`. On several:
`git rebase --signoff main`.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), with the package as the scope:

```
feat(core): subscription manager with leases and a minimal covering set
fix(mcp): listen for a stop before start-up, not after it
docs(readme): …
```

The body is for the reasoning, not the diff — why this way, what it rules out, what a reader
six months from now would otherwise have to guess.

## Changesets

A change that affects what a user installs needs a changeset:

```bash
npx changeset
```

Pick the packages, pick the bump, and write the line that will appear in the changelog — in
the user's language, not the implementer's. "Topic search no longer drops the last page" beats
"fix cursor off-by-one". Documentation, tests and internal refactors need none.

## What a reviewer will look for

Beyond "does it work":

- **No `any`, no non-null assertions, strict TypeScript.** The compiler settings are not
  negotiable; working around them usually means the model is wrong.
- **Module boundaries hold.** A local ESLint rule enforces the core's dependency table. The
  core must not import MCP, and `mqtt` may only be imported inside its adapter
  ([ADR-0003](docs/adr/0003-core-independent-from-mcp.md),
  [ADR-0006](docs/adr/0006-mqttjs-behind-transport-port.md)).
- **stdout is the MCP protocol.** Nothing else may be written there, ever. Logs go to stderr
  through the `Logger` port; `console` is banned outright.
- **Secrets never appear** in a log, an error, a serialization or a test fixture.
- **Memory stays bounded**, and whatever is dropped is counted and reported.
- **A new test fails if you break the thing it tests.** Try it: comment out the line the test
  is meant to protect and watch it go red. A test that passes either way is worse than none,
  because it buys confidence it has not earned.
- **Facts, observations and limitations stay apart.** The engine reports what it observed and
  what it computed, and never a cause. "The error stopped the machine" is not something an
  MQTT client can know ([ADR-0011](docs/adr/0011-facts-observations-limitations.md)).

## Pull requests

Pull requests go to `main`, squash-merged. Keep one concern per pull request: a reviewer who
has to hold two unrelated changes in their head reviews neither of them well.

Say in the description what you decided and what you rejected, and how you verified it. If
you found something surprising on the way, that is usually the most valuable paragraph.

`main` is protected by a repository ruleset, kept in
[`.github/rulesets/main.json`](.github/rulesets/main.json) so that changing it is reviewable
like anything else: no direct pushes, no force-pushes, no deleting the branch, linear history,
squash as the only merge method, every conversation resolved, and **CI success** green. That
last one is a single aggregate job that waits on the blocking ones, so the required check does
not have to be renamed every time the test matrix changes.

No approving review is required. This is a small project, and a rule nobody can satisfy is a
rule that gets bypassed — the ruleset is there to stop accidents, not to stand in for a
reviewer.

## Security

Do not open a public issue for a vulnerability. [SECURITY.md](SECURITY.md) says where to send
it.

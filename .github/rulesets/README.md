# Branch protection

`main.json` is the ruleset protecting the default branch. It is **not active yet**: branch
protection and rulesets need a public repository or a paid plan, and this repository is
private on the Free plan.

## What it enforces

- changes reach `main` through a pull request;
- the `CI success` check must pass, on an up-to-date branch;
- no force-push, no branch deletion, linear history;
- review threads must be resolved before merging.

`required_approving_review_count` is `0` so a solo maintainer is not blocked. Raise it to
`1` as soon as a second maintainer can review.

## Activating it

Once the repository is public (or the organisation is on a paid plan):

```bash
gh api --method POST repos/kadeyaorg/mqtt-intelligence-mcp/rulesets --input .github/rulesets/main.json
```

Check the result, then update this file if GitHub rejects or renames any parameter — the
JSON has not been applied yet, so it is unverified against the API.

Listing and updating afterwards:

```bash
gh api repos/kadeyaorg/mqtt-intelligence-mcp/rulesets
```

```bash
gh api --method PUT repos/kadeyaorg/mqtt-intelligence-mcp/rulesets/<id> --input .github/rulesets/main.json
```

## Meanwhile

`.githooks/pre-push` refuses direct pushes to `main` on a developer machine. It is a
convenience, not a control: it is local, and `--no-verify` skips it. It is configured
automatically by `npm install` (see `tools/setup-git-hooks.js`).

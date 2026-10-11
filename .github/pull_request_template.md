<!--
Thank you. A few notes to save you a round trip:

 - Every commit needs a DCO sign-off (`git commit -s`). See CONTRIBUTING.md.
 - A change a user would notice needs a changeset: `npx changeset`.
 - `npm run check` is what CI runs. `npm run test:integration` needs Docker.
-->

## What this changes

<!-- The behaviour, in a user's terms. Link the issue if there is one. -->

## Why this way

<!--
The part a reviewer cannot get from the diff: what you decided, what you rejected, and what
the change rules out. If something surprised you on the way, that is usually the most
valuable paragraph here.
-->

## How it was verified

<!--
What you ran, and what it said. Best of all: name the deliberate mutation you made to confirm
the new test actually fails when the behaviour breaks.
-->

## Checklist

- [ ] Commits are signed off (`git commit -s`)
- [ ] `npm run check` passes
- [ ] `npm run test:integration` passes, or this change cannot affect it
- [ ] A changeset is included, or no published behaviour changed
- [ ] A decision that contradicts an [ADR](../docs/adr/README.md) comes with a new ADR
- [ ] No secret reaches a log, an error, a serialization or a fixture; stdout still carries
      MCP protocol frames only

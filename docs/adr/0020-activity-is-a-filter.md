# ADR-0020 — Activity is a filter on search, not a tool of its own

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

The V0.2 plan listed a tool, `mqtt_get_activity`, answering "top rates, silent topics, new
topics".

Using the server against a real production line showed that two of those three already had an
answer. `mqtt_search_topics` sorts by `rate` for the busiest and filters by `silentForMs` for
the quiet, and both were used exactly that way during the investigation that drove this
version. Only "what is new" had no filter.

ADR-0012 keeps the tool surface small for a reason: every tool definition costs room in the
agent's context and dilutes its choice between them. A tool that mostly repeats what another
tool does is the worst case for that — the model has to decide which of two overlapping tools
to reach for, and either answer is defensible.

## Decision

- **No `mqtt_get_activity`.** The V0.2 plan is amended here rather than followed.
- `mqtt_search_topics` gains **`firstSeenSinceMs`**, the one capability that was missing. The
  activity story is then complete in one tool: sort by `rate` for the busiest, `silentForMs`
  for what stopped, `firstSeenSinceMs` for what is new.
- "First seen" means **first seen by this server**, never first published, and the tool
  description says so. A topic that has existed for years looks new the first time we are
  watching when it publishes, and a reader who takes it for "recently created" would be
  wrong in a way that matters.

## Consequences

- The tool surface stays at seven rather than eight, and the target of roughly eleven at V1
  (ADR-0012) now has room for the diagnostics tools of V0.3, which have no overlap with
  anything existing.
- An agent asking "what changed on this broker lately" makes one call with three filters
  instead of choosing between two tools.
- Anyone reading the V0.2 plan will find a tool that does not exist. This ADR is where that is
  explained; the plan document points here.
- If a future need genuinely does not fit a filter — a ranking across brokers, say — it can
  still become a tool. Nothing here forecloses that.

## Alternatives considered

- **Build `mqtt_get_activity` as planned.** Rejected: two thirds of it duplicates
  `mqtt_search_topics`, and the duplication is the cost, not the code.
- **Build it as a thin convenience wrapper.** Rejected for the same reason. A wrapper that
  exists to save an argument still costs a full tool definition in every context window.
- **Leave "what is new" out.** Rejected: it is the one question of the three that could not be
  asked at all, and it is the first thing anyone asks after an upgrade.

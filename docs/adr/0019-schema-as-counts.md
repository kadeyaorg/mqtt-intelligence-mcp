# ADR-0019 — An inferred schema is counts, and a wide object is a map

- **Status:** Accepted
- **Date:** 2026-10-18

## Context

MQTT carries no schema. The only way to describe a topic's payloads is to watch them, and
V0.2 makes that an answer the server gives rather than something a reader infers from one
sample.

Two constraints come from the engine rather than from JSON Schema. Catalogue statistics are
**mergeable**, so an ingest batch, several workers or a database aggregating server-side all
produce the same record (ADR-0008); a schema that is not mergeable would be the one piece of
the catalogue that cannot be sharded later. And everything per topic is **bounded**
(ADR-0009): a topic keyed by device id must not grow a field per device for ever.

The obvious representation — a tagged union of node kinds, with an `optional` flag per field
— satisfies neither well. Merging two unions needs rules for every pair of kinds, and
`optional` is a conclusion that two merged halves can disagree about.

## Decision

- A schema node is **counts**: how many values were observed at a position, and how many of
  each JSON type. Merging is addition, which is commutative and associative by construction.
- **Optionality is derived, never stored.** A field whose `seen` is lower than its parent's
  object count was absent from some payloads. The exported schema turns that into `required`
  or not; the node itself holds no flag that could contradict the counts.
- **A union is what counts above zero in more than one type look like.** No separate union
  node exists.
- An object with more than `maxFields` (32) distinct keys **becomes a map**: every field is
  folded into one value shape and the key count is kept. This is usually more accurate — such
  an object is keyed by an identifier, not a record — and it is what bounds the schema.
  Folding is commutative, so a merge where either side has folded folds the other and reaches
  the same answer whatever the order.
- Nesting beyond `maxDepth` (6) stops, and the node is **marked truncated**, which the export
  repeats as a `$comment`. A partial shape is never presented as the whole one (ADR-0011).
- A per-topic **node budget** (512) is a safety valve: once reached, new fields stop being
  added and the node is marked truncated.
- The export is JSON Schema draft 2020-12, and says in its own text that it summarises what
  was seen rather than a contract anyone promised.

## Consequences

- Schemas merge exactly, and a property test over random payloads split at random points
  asserts it. The scale-out path stays open without a second data model.
- Memory per topic is bounded by depth, field count and the node budget rather than by
  traffic.
- **The node budget is the one place where order can matter.** A topic whose payloads never
  repeat a key may end up describing different fields depending on the order they arrived in.
  Everything within the limits merges exactly, and the node says it was truncated, so the
  answer is never silently partial. We preferred a hard bound with a stated exception to
  perfect determinism with none.
- Counts cost more memory than flags, and buy the ability to say "this field was present in
  40 of 100 payloads" — which is more useful to a reader than "optional".
- String and numeric refinements (enums, ranges, formats) are not inferred. They are
  additive: each is another count beside the existing ones, and none changes this model.

## Alternatives considered

- **A tagged union of node kinds with an `optional` flag.** Rejected: merging needs a rule
  per pair of kinds, and the flag is a derived fact stored as if it were an observation, so
  two halves can disagree.
- **Keeping every key of a wide object.** Rejected: unbounded by construction, and it
  describes a map keyed by device id as a record with a thousand fields, which is wrong as
  well as expensive.
- **Sampling payloads for inference separately.** Rejected: ingestion already samples and
  budgets inspection, so inference rides on the payloads that were going to be parsed anyway.
- **A third-party inference library.** Rejected: none of them merge, which is the property
  that matters most here, and the whole model is under two hundred lines.

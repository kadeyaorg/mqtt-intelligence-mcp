# ADR-0008 — Separate TopicCatalog and MessageStore ports; in-memory first

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

V0.1 must run without external infrastructure, while leaving room for SQLite, Redis,
PostgreSQL or TimescaleDB later. The brief's `MessageStore` interface mixed two concerns with
opposite access patterns:

- a **topic catalog**: one aggregated record per topic, updated on every message;
- a **message log**: append-only, time-ordered, retention-bounded, queried by time range.

## Decision

- Two ports in `core`: `TopicCatalog` (`applyBatch`, `get`, `query`, `tree`, `stats`) and
  `MessageStore` (`append`, `recent`, `query`, `stats`).
- **Batch writes only** (`applyBatch(deltas)`, `append(batch)`), fed by the ingest flush
  cycle. No per-message awaited write.
- **Cursor pagination** in every query (opaque cursors, no offsets).
- Catalog records are built from **mergeable deltas** (ADR-0009) so that a database
  implementation can aggregate server-side (`UPDATE … SET count = count + $n`).
- V0.1 implementations: `MemoryTopicCatalog` (Map + LRU, `maxTopicsPerBroker`) and
  `MemoryMessageStore` (per-topic ring buffers + global byte budget, oldest-first eviction).
- A **shared contract test suite** published under `core/testing` defines the behaviour
  every implementation must pass.
- No part of the engine accesses storage other than through these ports.
- First persistent adapter candidate: **SQLite through `node:sqlite`** (no external
  service, no native addon to install).

## Consequences

- Positive: storage adapters are drop-in; the contract suite prevents behavioural drift.
- Positive: memory implementation is bounded by construction.
- Negative: asynchronous interfaces even for the in-memory case (negligible cost with
  batching).

## Alternatives considered

- **A single store interface:** forces awkward implementations in real databases.
- **Embedding a database in V0.1:** adds installation friction before the data model has
  settled.

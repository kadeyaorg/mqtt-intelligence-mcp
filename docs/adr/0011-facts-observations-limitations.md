# ADR-0011 — Facts, observations and limitations in every answer

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Language models readily turn temporal proximity into causality and partial visibility into
certainty ("topic X does not exist", "the error caused the stop"). Our value depends on the
agent reasoning from correct premises. MQTT itself adds traps: receipt time is not publish
time, delivered QoS is not publisher QoS, retained replays are not live messages.

## Decision

Every engine answer uses the envelope `Answer<Facts, Observations>`:

- **facts**: values observed directly (counts, receipt timestamps, delivered QoS, payload
  views, retained replay flags);
- **observations**: values _computed deterministically_ from facts, each with a documented
  method (rates, inter-arrival statistics, "silent for 12× its mean interval", tree
  aggregates; later: schema, temporal proximity between events);
- **coverage**: what the engine could see (ADR-0007);
- **limitations**: machine-readable codes with a sentence each (`SHORT_OBSERVATION_WINDOW`,
  `DISCONNECTED_DURING_WINDOW`, `DELIVERED_QOS_ONLY`, `RETAINED_REPLAY_TIME_UNKNOWN`,
  `PAYLOADS_DROPPED`, `SAMPLED`, `TRUNCATED`, …).

The engine **never** produces inferences (causes, intentions, business meaning). Temporal
relations in timelines (V0.3) are expressed as measured deltas ("2 ms earlier"), never as
causes. MCP prompts (V0.2) ask the agent to label its own inferences.

## Consequences

- Positive: the agent can distinguish certainty levels; answers are auditable.
- Negative: slightly larger outputs. Mitigated by concise limitation messages and by
  including only the limitations that apply to a given answer.

## Alternatives considered

- **Plain data without caveats:** smaller, but systematically misleading in the cases that
  matter most (incidents, missing topics).

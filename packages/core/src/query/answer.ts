/**
 * The shape of every answer the engine gives (ADR-0011).
 *
 * Three sections, because three different things are being said:
 *
 * - **facts**: observed directly — counts, receipt times, payloads;
 * - **observations**: computed from facts by a documented method — rates, intervals, silence;
 * - **limitations**: what this answer *cannot* tell, which is the part a model would
 *   otherwise invent.
 *
 * There is deliberately no fourth section. The engine never infers causes, intentions or
 * business meaning: that is the agent's job, and conflating the two is how a temporal
 * coincidence becomes a confident root cause.
 */
import type { ObservationCoverage } from '../domain/coverage.js';

export type LimitationCode =
  | 'SHORT_OBSERVATION_WINDOW'
  | 'DISCONNECTED_DURING_WINDOW'
  | 'FILTER_REJECTED'
  | 'DELIVERED_QOS_ONLY'
  | 'RETAINED_REPLAY_TIME_UNKNOWN'
  | 'PAYLOADS_DROPPED'
  | 'MESSAGES_DENIED'
  | 'TOPICS_EVICTED'
  | 'SAMPLED'
  | 'TRUNCATED'
  | 'RESULTS_TRUNCATED'
  | 'SCHEMA_TRUNCATED';

export interface Limitation {
  readonly code: LimitationCode;
  readonly message: string;
}

export interface Answer<Facts, Observations = never> {
  readonly facts: Facts;
  readonly observations?: Observations;
  readonly coverage: ObservationCoverage;
  readonly limitations: readonly Limitation[];
}

/** Below this, a listing says more about the window than about the broker. */
export const SHORT_OBSERVATION_MS = 60_000;

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${String(Math.round(milliseconds))} ms`;
  }
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 120 ? `${String(seconds)} s` : `${String(Math.round(seconds / 60))} min`;
}

/**
 * Turns what the engine knows about its own blind spots into statements.
 *
 * Every one of these is a case where silence or absence would otherwise be read as evidence.
 */
export function coverageLimitations(coverage: ObservationCoverage): Limitation[] {
  const limitations: Limitation[] = [];

  if (coverage.observedMs < SHORT_OBSERVATION_MS) {
    limitations.push({
      code: 'SHORT_OBSERVATION_WINDOW',
      message: `Observation has lasted ${formatDuration(coverage.observedMs)}. Topics that publish less often than that may exist without appearing here: "not observed" does not mean "does not exist".`,
    });
  }

  const openGaps = coverage.gaps.filter((gap) => gap.to === undefined).length;
  if (coverage.gaps.length > 0) {
    limitations.push({
      code: 'DISCONNECTED_DURING_WINDOW',
      message: `The engine was not connected for ${String(coverage.gaps.length)} period(s)${openGaps > 0 ? ', including now' : ''}. Messages published then were never seen, so a topic looking silent may simply not have been observed.`,
    });
  }

  if (coverage.rejectedFilters.length > 0) {
    const filters = coverage.rejectedFilters.map((rejected) => `"${rejected.filter}"`).join(', ');
    limitations.push({
      code: 'FILTER_REJECTED',
      message: `Nothing is observed under ${filters}: ${coverage.rejectedFilters[0]?.reason ?? 'refused'}.`,
    });
  }

  if (coverage.deniedMessages > 0) {
    limitations.push({
      code: 'MESSAGES_DENIED',
      message: `${String(coverage.deniedMessages)} message(s) were refused by the read policy and are absent from every count and listing.`,
    });
  }

  if (coverage.droppedPayloads > 0) {
    limitations.push({
      code: 'PAYLOADS_DROPPED',
      message: `${String(coverage.droppedPayloads)} payload(s) were dropped to stay within memory budgets. Message counts are unaffected; stored payloads are incomplete.`,
    });
  }

  if (coverage.evictedTopics > 0 || coverage.ignoredTopics > 0) {
    const dropped = coverage.evictedTopics + coverage.ignoredTopics;
    limitations.push({
      code: 'TOPICS_EVICTED',
      message: `${String(dropped)} topic(s) were dropped because the per-broker topic limit was reached. This listing is incomplete.`,
    });
  }

  return limitations;
}

/** The delivered QoS is not the publisher's: a caveat worth repeating wherever QoS is shown. */
export const DELIVERED_QOS_LIMITATION: Limitation = {
  code: 'DELIVERED_QOS_ONLY',
  message:
    "QoS values are the delivered QoS, which is the minimum of the publisher's and the subscription's. They are not necessarily what the publisher asked for.",
};

export const RETAINED_REPLAY_LIMITATION: Limitation = {
  code: 'RETAINED_REPLAY_TIME_UNKNOWN',
  message:
    'Some messages were retained messages replayed by the broker at subscribe time. Their timestamps are receipt times; when they were actually published is unknown, and they are excluded from rates.',
};

export const SAMPLED_HISTORY_LIMITATION: Limitation = {
  code: 'SAMPLED',
  message:
    'Stored history is sampled at no more than one message per topic per flush interval. Message counts are exact and the last message is exact; the messages in between are a sample.',
};

export const SCHEMA_TRUNCATED_LIMITATION: Limitation = {
  code: 'SCHEMA_TRUNCATED',
  message:
    'A limit stopped schema inference somewhere inside the payload: depth, the number of fields in one object, or the node budget. The real payload may hold more than the shape shows.',
};

export function truncatedResults(shown: number, total: number): Limitation {
  return {
    code: 'RESULTS_TRUNCATED',
    message: `Showing ${String(shown)} of ${String(total)} matching topics. Narrow the filter or continue with the cursor.`,
  };
}

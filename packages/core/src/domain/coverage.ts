/**
 * What discovery was able to see (ADR-0007).
 *
 * The type lives beside the answer envelope rather than with the service that fills it,
 * because coverage is part of what an answer *says*: every listing, description and history
 * carries it, so that "not observed" is never read as "does not exist".
 */
import type { BrokerId } from './ids.js';
import type { TopicFilter } from './topic.js';

export interface RejectedFilterReport {
  readonly filter: TopicFilter;
  readonly reason: string;
}

export interface ObservationGap {
  readonly from: number;
  readonly to?: number;
  readonly reason: 'disconnected' | 'not-started';
}

export interface ObservationCoverage {
  readonly brokerId: BrokerId;
  /** Filters actually subscribed, after the policy narrowed anything it had to. */
  readonly filters: readonly TopicFilter[];
  /** Filters nobody is observing, and why. */
  readonly rejectedFilters: readonly RejectedFilterReport[];
  readonly observingSince?: number;
  /** Milliseconds actually spent connected and subscribed. */
  readonly observedMs: number;
  /** Periods with no observation at all. Bounded: only the most recent ones are kept. */
  readonly gaps: readonly ObservationGap[];
  readonly droppedPayloads: number;
  readonly deniedMessages: number;
  readonly evictedTopics: number;
  readonly ignoredTopics: number;
  readonly topicCount: number;
  readonly messageCount: number;
}

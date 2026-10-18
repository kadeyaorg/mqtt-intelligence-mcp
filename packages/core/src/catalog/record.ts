/**
 * What the catalog knows about a topic, and the deltas that build it.
 *
 * The record is what an agent is eventually shown, so the vocabulary is chosen to avoid the
 * four MQTT traps that make a confident wrong answer easy (ADR-0011):
 *
 * - times are **receipt** times: MQTT carries no publish timestamp;
 * - QoS is **delivered** QoS, which is the minimum of the publisher's and ours;
 * - a **retained replay** is a message the broker kept, not a live publication, so it is
 *   counted apart and never feeds the rate;
 * - payload kinds are counted over **inspected** messages only, since ingestion samples.
 */
import type { BrokerId } from '../domain/ids.js';
import type { TopicName } from '../domain/topic.js';
import type { PayloadKind } from '../payload/index.js';
import type { DistributionState, RateState } from './stats.js';
import {
  createRate,
  EMPTY_DISTRIBUTION,
  mergeDistributions,
  mergeIntervalBuckets,
  mergeRates,
  observeRate,
} from './stats.js';

/** Counts of delivered QoS 0, 1 and 2. */
export type QosCounts = readonly [number, number, number];

export type PayloadKindCounts = Readonly<Partial<Record<PayloadKind, number>>>;

/** Whether the broker is holding a retained message for this topic, as far as we saw. */
export type RetainedState = 'present' | 'cleared' | 'unknown';

export interface TopicRecord {
  readonly brokerId: BrokerId;
  readonly topic: TopicName;
  /** Receipt time of the first message we saw. */
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  /** Receipt time of the last live message, excluding retained replays. */
  readonly lastLiveAt?: number;
  readonly messageCount: number;
  readonly retainedReplayCount: number;
  readonly bytesTotal: number;
  readonly maxPayloadSize: number;
  readonly qosCounts: QosCounts;
  readonly retainedState: RetainedState;
  /** Counted over inspected messages only. */
  readonly payloadKinds: PayloadKindCounts;
  readonly inspectedCount: number;
  /** Live messages per second, time-decayed. */
  readonly rate: RateState;
  /** Inter-arrival times of live messages, in milliseconds. */
  readonly interArrival: DistributionState;
  /** Those same intervals in power-of-two buckets; undefined means none counted yet. */
  readonly intervalBuckets?: readonly number[];
}

/**
 * What one ingest flush observed about one topic.
 *
 * Deltas are the unit of merging: the same traffic, split into any number of deltas and
 * applied in any grouping, must produce the same record.
 */
export interface TopicDelta {
  readonly topic: TopicName;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly lastLiveAt?: number;
  readonly messageCount: number;
  readonly retainedReplayCount: number;
  readonly bytesTotal: number;
  readonly maxPayloadSize: number;
  readonly qosCounts: QosCounts;
  readonly retainedState?: RetainedState;
  readonly payloadKinds: PayloadKindCounts;
  readonly inspectedCount: number;
  /** Live messages in this delta, which feed the rate. */
  readonly liveCount: number;
  /** Inter-arrival times measured within this delta. */
  readonly interArrival?: DistributionState;
  readonly intervalBuckets?: readonly number[];
}

function addQos(left: QosCounts, right: QosCounts): QosCounts {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function addKinds(left: PayloadKindCounts, right: PayloadKindCounts): PayloadKindCounts {
  const merged: Partial<Record<PayloadKind, number>> = { ...left };
  for (const [kind, count] of Object.entries(right) as [PayloadKind, number][]) {
    merged[kind] = (merged[kind] ?? 0) + count;
  }
  return merged;
}

/** A later observation wins, because the retained message may have been cleared. */
function mergeRetained(current: RetainedState, update: RetainedState | undefined): RetainedState {
  return update ?? current;
}

export function createRecord(
  brokerId: BrokerId,
  delta: TopicDelta,
  timeConstantMs?: number,
): TopicRecord {
  const rate = observeRate(
    createRate(delta.firstSeenAt, timeConstantMs),
    delta.liveCount,
    delta.lastSeenAt,
  );
  return {
    brokerId,
    topic: delta.topic,
    firstSeenAt: delta.firstSeenAt,
    lastSeenAt: delta.lastSeenAt,
    ...(delta.lastLiveAt === undefined ? {} : { lastLiveAt: delta.lastLiveAt }),
    messageCount: delta.messageCount,
    retainedReplayCount: delta.retainedReplayCount,
    bytesTotal: delta.bytesTotal,
    maxPayloadSize: delta.maxPayloadSize,
    qosCounts: delta.qosCounts,
    retainedState: delta.retainedState ?? 'unknown',
    payloadKinds: delta.payloadKinds,
    inspectedCount: delta.inspectedCount,
    rate,
    interArrival: delta.interArrival ?? EMPTY_DISTRIBUTION,
    ...(delta.intervalBuckets === undefined ? {} : { intervalBuckets: delta.intervalBuckets }),
  };
}

/** Spreads the field only when there is one, which exactOptionalPropertyTypes requires. */
function buckets(value: readonly number[] | undefined): { intervalBuckets?: readonly number[] } {
  return value === undefined ? {} : { intervalBuckets: value };
}

/** Folds a delta into an existing record. Order between deltas does not change the result. */
export function applyDelta(record: TopicRecord, delta: TopicDelta): TopicRecord {
  const lastLiveAt =
    delta.lastLiveAt === undefined
      ? record.lastLiveAt
      : Math.max(record.lastLiveAt ?? 0, delta.lastLiveAt);

  return {
    brokerId: record.brokerId,
    topic: record.topic,
    firstSeenAt: Math.min(record.firstSeenAt, delta.firstSeenAt),
    lastSeenAt: Math.max(record.lastSeenAt, delta.lastSeenAt),
    ...(lastLiveAt === undefined ? {} : { lastLiveAt }),
    messageCount: record.messageCount + delta.messageCount,
    retainedReplayCount: record.retainedReplayCount + delta.retainedReplayCount,
    bytesTotal: record.bytesTotal + delta.bytesTotal,
    maxPayloadSize: Math.max(record.maxPayloadSize, delta.maxPayloadSize),
    qosCounts: addQos(record.qosCounts, delta.qosCounts),
    retainedState: mergeRetained(record.retainedState, delta.retainedState),
    payloadKinds: addKinds(record.payloadKinds, delta.payloadKinds),
    inspectedCount: record.inspectedCount + delta.inspectedCount,
    rate: observeRate(record.rate, delta.liveCount, delta.lastSeenAt),
    interArrival: mergeDistributions(record.interArrival, delta.interArrival ?? EMPTY_DISTRIBUTION),
    ...buckets(mergeIntervalBuckets(record.intervalBuckets, delta.intervalBuckets)),
  };
}

/** Merges two records of the same topic, as two ingest workers would produce. */
export function mergeRecords(left: TopicRecord, right: TopicRecord): TopicRecord {
  const lastLiveAt =
    left.lastLiveAt === undefined && right.lastLiveAt === undefined
      ? undefined
      : Math.max(left.lastLiveAt ?? 0, right.lastLiveAt ?? 0);

  return {
    brokerId: left.brokerId,
    topic: left.topic,
    firstSeenAt: Math.min(left.firstSeenAt, right.firstSeenAt),
    lastSeenAt: Math.max(left.lastSeenAt, right.lastSeenAt),
    ...(lastLiveAt === undefined ? {} : { lastLiveAt }),
    messageCount: left.messageCount + right.messageCount,
    retainedReplayCount: left.retainedReplayCount + right.retainedReplayCount,
    bytesTotal: left.bytesTotal + right.bytesTotal,
    maxPayloadSize: Math.max(left.maxPayloadSize, right.maxPayloadSize),
    qosCounts: addQos(left.qosCounts, right.qosCounts),
    retainedState: left.lastSeenAt >= right.lastSeenAt ? left.retainedState : right.retainedState,
    payloadKinds: addKinds(left.payloadKinds, right.payloadKinds),
    inspectedCount: left.inspectedCount + right.inspectedCount,
    rate: mergeRates(left.rate, right.rate),
    interArrival: mergeDistributions(left.interArrival, right.interArrival),
    ...buckets(mergeIntervalBuckets(left.intervalBuckets, right.intervalBuckets)),
  };
}

/** How long a topic has been silent, relative to how often it normally publishes. */
export function silenceRatio(record: TopicRecord, now: number): number | undefined {
  const lastLiveAt = record.lastLiveAt;
  if (lastLiveAt === undefined || record.interArrival.count < 2) {
    return undefined;
  }
  const mean = record.interArrival.mean;
  return mean <= 0 ? undefined : (now - lastLiveAt) / mean;
}

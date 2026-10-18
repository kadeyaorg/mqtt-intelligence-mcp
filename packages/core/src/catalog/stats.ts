/**
 * Statistics that can be merged (ADR-0009).
 *
 * Two constraints shape these: they are updated on the hot path, so each must cost O(1) per
 * message and keep O(1) memory per topic whatever the traffic; and they must be
 * **mergeable**, so that an ingest batch, several ingest workers, or a database aggregating
 * server-side all produce the same record. Mergeability is what keeps the scale-out path
 * open without changing the data model later.
 *
 * A plain `count / (lastSeen - firstSeen)` was rejected: it is wrong for bursty topics and
 * never decays, so a topic that stopped an hour ago would still report its old rate.
 */

/** Time constant of the rate estimate. Roughly "the last minute matters most". */
export const DEFAULT_RATE_TIME_CONSTANT_MS = 60_000;

/** A time-decayed rate, in messages per second. */
export interface RateState {
  /** Messages per second, as of `at`. */
  readonly perSecond: number;
  /** Wall-clock milliseconds of the last update. */
  readonly at: number;
  readonly timeConstantMs: number;
}

export function createRate(at: number, timeConstantMs = DEFAULT_RATE_TIME_CONSTANT_MS): RateState {
  return { perSecond: 0, at, timeConstantMs };
}

/** Decays a rate forward in time without observing anything. */
export function decayRate(state: RateState, at: number): RateState {
  if (at <= state.at) {
    return state;
  }
  const elapsedSeconds = (at - state.at) / 1000;
  const factor = Math.exp(-elapsedSeconds / (state.timeConstantMs / 1000));
  return { ...state, perSecond: state.perSecond * factor, at };
}

/** Records `count` messages observed at `at`. */
export function observeRate(state: RateState, count: number, at: number): RateState {
  const decayed = decayRate(state, at);
  const timeConstantSeconds = state.timeConstantMs / 1000;
  return { ...decayed, perSecond: decayed.perSecond + count / timeConstantSeconds };
}

/**
 * Merges two rates by bringing both to the later instant and adding them.
 *
 * Rates are additive, which is what lets two workers observe disjoint parts of a topic's
 * traffic and still report the rate of the whole.
 */
export function mergeRates(left: RateState, right: RateState): RateState {
  const at = Math.max(left.at, right.at);
  const a = decayRate(left, at);
  const b = decayRate(right, at);
  return { perSecond: a.perSecond + b.perSecond, at, timeConstantMs: left.timeConstantMs };
}

/**
 * Running count, mean, variance and extremes, in constant memory.
 *
 * Used for inter-arrival times, which is what makes "this topic has gone quiet" answerable:
 * silence only means something relative to how often a topic normally publishes.
 */
export interface DistributionState {
  readonly count: number;
  readonly mean: number;
  /** Sum of squared deviations from the mean (Welford's M2). */
  readonly sumOfSquares: number;
  readonly min: number;
  readonly max: number;
}

export const EMPTY_DISTRIBUTION: DistributionState = {
  count: 0,
  mean: 0,
  sumOfSquares: 0,
  min: Number.POSITIVE_INFINITY,
  max: Number.NEGATIVE_INFINITY,
};

/** Welford's online update: numerically stable, one pass, no stored samples. */
export function observeValue(state: DistributionState, value: number): DistributionState {
  const count = state.count + 1;
  const delta = value - state.mean;
  const mean = state.mean + delta / count;
  return {
    count,
    mean,
    sumOfSquares: state.sumOfSquares + delta * (value - mean),
    min: Math.min(state.min, value),
    max: Math.max(state.max, value),
  };
}

/** Chan's parallel variance merge, so batches and workers combine exactly. */
export function mergeDistributions(
  left: DistributionState,
  right: DistributionState,
): DistributionState {
  if (left.count === 0) {
    return right;
  }
  if (right.count === 0) {
    return left;
  }
  const count = left.count + right.count;
  const delta = right.mean - left.mean;
  const mean = left.mean + (delta * right.count) / count;
  return {
    count,
    mean,
    sumOfSquares:
      left.sumOfSquares + right.sumOfSquares + delta * delta * ((left.count * right.count) / count),
    min: Math.min(left.min, right.min),
    max: Math.max(left.max, right.max),
  };
}

/** Sample variance, or `undefined` below two observations. */
export function variance(state: DistributionState): number | undefined {
  return state.count < 2 ? undefined : state.sumOfSquares / (state.count - 1);
}

export function standardDeviation(state: DistributionState): number | undefined {
  const value = variance(state);
  return value === undefined ? undefined : Math.sqrt(value);
}

/**
 * A coarse, mergeable picture of how inter-arrival times are spread.
 *
 * The mean and the deviation say a topic is irregular; they cannot say *how*. A topic
 * published once per cycle and one published twice per cycle both come out "irregular", and
 * only the second has two groups of gaps — a short one inside the cycle and a long one
 * between cycles. Telling them apart needs the shape of the distribution, not a summary of
 * it, and that was worth a day of hand-written captures to discover on a real machine.
 *
 * Buckets are powers of two in milliseconds, which is coarse on purpose: the question is
 * which groups exist, not what their mean is to three digits. Twenty of them reach from 1 ms
 * to about nine minutes, and a topic quieter than that has no groups worth reporting.
 * Element-wise addition merges them, so the mergeability contract holds (ADR-0008).
 */
export const INTERVAL_BUCKET_COUNT = 20;

/** Bucket `i` holds intervals in `[2^i, 2^(i+1))` milliseconds. */
export function intervalBucketOf(milliseconds: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds < 1) {
    return 0;
  }
  return Math.min(INTERVAL_BUCKET_COUNT - 1, Math.floor(Math.log2(milliseconds)));
}

export function intervalBucketRange(index: number): {
  readonly fromMs: number;
  readonly toMs: number;
} {
  return { fromMs: 2 ** index, toMs: 2 ** (index + 1) };
}

/** Counts one interval. `undefined` stands for all-zero, so a quiet topic costs nothing. */
export function observeInterval(
  buckets: readonly number[] | undefined,
  milliseconds: number,
): readonly number[] {
  const next =
    buckets === undefined ? new Array<number>(INTERVAL_BUCKET_COUNT).fill(0) : [...buckets];
  const index = intervalBucketOf(milliseconds);
  next[index] = (next[index] ?? 0) + 1;
  return next;
}

export function mergeIntervalBuckets(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
): readonly number[] | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return left.map((count, index) => count + (right[index] ?? 0));
}

/** One cluster of inter-arrival times, as a range rather than a falsely precise average. */
export interface IntervalGroup {
  readonly fromMs: number;
  readonly toMs: number;
  readonly count: number;
}

/** Below this, a second group is as likely to be jitter as a real pattern. */
const MIN_INTERVALS_FOR_GROUPS = 12;
/** A group must hold at least this share of the intervals to be worth reporting. */
const MIN_GROUP_SHARE = 0.15;

/**
 * A bucket holding less than this share of the intervals is treated as a valley rather than
 * as a bridge between two groups. Without it, one stray interval landing between the groups
 * welds them together, and real distributions always have a stray interval: a dropped
 * message, a reconnection, a scheduler hiccup.
 */
const NOISE_SHARE = 0.03;

/**
 * Splits the populated buckets into groups, cutting at runs of near-empty ones.
 *
 * Reporting the groups is a fact about the distribution. What they *mean* — two publishers,
 * one loop publishing twice, a retry — is not something arrival times can settle, so this
 * returns the shape and says nothing about the cause (ADR-0011).
 */
export function intervalGroups(buckets: readonly number[] | undefined): readonly IntervalGroup[] {
  if (buckets === undefined) {
    return [];
  }
  const total = buckets.reduce((sum, count) => sum + count, 0);
  if (total < MIN_INTERVALS_FOR_GROUPS) {
    return [];
  }
  // At least one: a single interval is always a stray, whatever the sample size.
  const noiseFloor = Math.max(1, total * NOISE_SHARE);

  const groups: IntervalGroup[] = [];
  let current: { from: number; to: number; count: number } | undefined;
  let emptyRun = 0;
  for (const [index, count] of buckets.entries()) {
    if (count <= noiseFloor) {
      emptyRun += 1;
      continue;
    }
    // One empty bucket is the boundary between two powers of two and separates nothing; two
    // in a row mean the values really are an order of magnitude apart.
    if (current !== undefined && emptyRun >= 2) {
      groups.push({ fromMs: 2 ** current.from, toMs: 2 ** (current.to + 1), count: current.count });
      current = undefined;
    }
    emptyRun = 0;
    current =
      current === undefined
        ? { from: index, to: index, count }
        : { from: current.from, to: index, count: current.count + count };
  }
  if (current !== undefined) {
    groups.push({ fromMs: 2 ** current.from, toMs: 2 ** (current.to + 1), count: current.count });
  }

  const significant = groups.filter((group) => group.count / total >= MIN_GROUP_SHARE);
  // One group is just "this topic has a period": the summary already says that.
  return significant.length >= 2 ? significant : [];
}

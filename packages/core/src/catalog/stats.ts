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

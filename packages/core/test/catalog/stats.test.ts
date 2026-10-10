import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TopicDelta, TopicRecord } from '../../src/index.js';
import {
  applyDelta,
  createRate,
  createRecord,
  decayRate,
  EMPTY_DISTRIBUTION,
  mergeDistributions,
  mergeRates,
  mergeRecords,
  observeRate,
  observeValue,
  parseBrokerId,
  parseTopicName,
  silenceRatio,
  standardDeviation,
  variance,
} from '../../src/index.js';

const BROKER = parseBrokerId('factory-fr');
const TOPIC = parseTopicName('factory/line-01/robot/status');
const TAU = 60_000;

describe('rate', () => {
  it('reports roughly the arrival rate of a steady stream', () => {
    let rate = createRate(0, TAU);
    // One message every 100 ms for five minutes: ten per second.
    for (let at = 100; at <= 300_000; at += 100) {
      rate = observeRate(rate, 1, at);
    }

    expect(rate.perSecond).toBeCloseTo(10, 0);
  });

  it('decays towards zero once a topic stops', () => {
    const busy = observeRate(createRate(0, TAU), 600, 60_000);

    const afterOneTimeConstant = decayRate(busy, 60_000 + TAU);
    const afterFive = decayRate(busy, 60_000 + 5 * TAU);

    expect(afterOneTimeConstant.perSecond / busy.perSecond).toBeCloseTo(Math.exp(-1), 5);
    expect(afterFive.perSecond).toBeLessThan(busy.perSecond * 0.01);
  });

  it('never goes backwards in time', () => {
    const rate = observeRate(createRate(0, TAU), 10, 1000);

    expect(decayRate(rate, 500)).toEqual(rate);
  });

  it('adds up when two observers split the traffic', () => {
    const together = observeRate(createRate(0, TAU), 20, 1000);
    const left = observeRate(createRate(0, TAU), 12, 1000);
    const right = observeRate(createRate(0, TAU), 8, 1000);

    expect(mergeRates(left, right).perSecond).toBeCloseTo(together.perSecond, 10);
  });

  it('brings both sides to the later instant before adding them', () => {
    const early = observeRate(createRate(0, TAU), 10, 1000);
    const late = observeRate(createRate(0, TAU), 10, 61_000);

    const merged = mergeRates(early, late);

    expect(merged.at).toBe(61_000);
    expect(merged.perSecond).toBeCloseTo(decayRate(early, 61_000).perSecond + late.perSecond, 10);
  });
});

describe('distribution', () => {
  it('computes mean, variance and extremes', () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];

    const state = values.reduce(observeValue, EMPTY_DISTRIBUTION);

    expect(state.count).toBe(8);
    expect(state.mean).toBeCloseTo(5, 10);
    expect(state.min).toBe(2);
    expect(state.max).toBe(9);
    // Sample variance, not population: 32 / 7.
    expect(variance(state)).toBeCloseTo(32 / 7, 10);
    expect(standardDeviation(state)).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });

  it('has no variance below two observations', () => {
    expect(variance(EMPTY_DISTRIBUTION)).toBeUndefined();
    expect(variance(observeValue(EMPTY_DISTRIBUTION, 5))).toBeUndefined();
  });

  it('merges two halves into the whole', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const whole = values.reduce(observeValue, EMPTY_DISTRIBUTION);
    const left = values.slice(0, 4).reduce(observeValue, EMPTY_DISTRIBUTION);
    const right = values.slice(4).reduce(observeValue, EMPTY_DISTRIBUTION);

    const merged = mergeDistributions(left, right);

    expect(merged.count).toBe(whole.count);
    expect(merged.mean).toBeCloseTo(whole.mean, 10);
    expect(variance(merged) ?? 0).toBeCloseTo(variance(whole) ?? 0, 10);
    expect(merged.min).toBe(whole.min);
    expect(merged.max).toBe(whole.max);
  });

  it('treats an empty side as nothing', () => {
    const state = observeValue(EMPTY_DISTRIBUTION, 5);

    expect(mergeDistributions(state, EMPTY_DISTRIBUTION)).toEqual(state);
    expect(mergeDistributions(EMPTY_DISTRIBUTION, state)).toEqual(state);
  });
});

function deltaAt(at: number, overrides: Partial<TopicDelta> = {}): TopicDelta {
  return {
    topic: TOPIC,
    firstSeenAt: at,
    lastSeenAt: at,
    lastLiveAt: at,
    messageCount: 1,
    retainedReplayCount: 0,
    bytesTotal: 10,
    maxPayloadSize: 10,
    qosCounts: [1, 0, 0],
    payloadKinds: { json: 1 },
    inspectedCount: 1,
    liveCount: 1,
    ...overrides,
  };
}

function fold(deltas: readonly TopicDelta[]): TopicRecord {
  const [first, ...rest] = deltas;
  if (first === undefined) {
    throw new Error('at least one delta is required');
  }
  return rest.reduce(applyDelta, createRecord(BROKER, first, TAU));
}

describe('records', () => {
  it('separates retained replays from live messages', () => {
    // A replay carries no lastLiveAt at all: the broker kept it, nobody just published it.
    const replay: TopicDelta = {
      topic: TOPIC,
      firstSeenAt: 2000,
      lastSeenAt: 2000,
      messageCount: 1,
      retainedReplayCount: 1,
      bytesTotal: 10,
      maxPayloadSize: 10,
      qosCounts: [1, 0, 0],
      payloadKinds: { json: 1 },
      inspectedCount: 1,
      liveCount: 0,
    };
    const record = fold([deltaAt(1000), replay]);

    expect(record.messageCount).toBe(2);
    expect(record.retainedReplayCount).toBe(1);
    // A replay is not evidence of a recent publication.
    expect(record.lastLiveAt).toBe(1000);
    expect(record.lastSeenAt).toBe(2000);
  });

  it('keeps the latest view of the retained state', () => {
    const record = fold([
      deltaAt(1000, { retainedState: 'present' }),
      deltaAt(2000, { retainedState: 'cleared' }),
    ]);

    expect(record.retainedState).toBe('cleared');
  });

  it('measures silence against how often the topic normally publishes', () => {
    const record = fold(
      [1000, 2000, 3000, 4000].map((at) =>
        deltaAt(at, {
          interArrival: observeValue(EMPTY_DISTRIBUTION, 1000),
        }),
      ),
    );

    // Mean interval is one second; ten seconds of silence is ten intervals.
    expect(silenceRatio(record, 14_000)).toBeCloseTo(10, 5);
  });

  it('has no silence ratio without enough history to compare against', () => {
    expect(silenceRatio(fold([deltaAt(1000)]), 5000)).toBeUndefined();
  });
});

describe('merging is independent of how the traffic was grouped', () => {
  const deltaArbitrary = fc.record({
    gap: fc.integer({ min: 1, max: 5000 }),
    messages: fc.integer({ min: 1, max: 20 }),
    bytes: fc.integer({ min: 1, max: 4096 }),
  });

  it('folding sequentially equals merging two partial folds', () => {
    fc.assert(
      fc.property(
        fc.array(deltaArbitrary, { minLength: 2, maxLength: 20 }),
        fc.integer({ min: 1, max: 19 }),
        (steps, splitAt) => {
          let at = 1000;
          const deltas = steps.map((step) => {
            at += step.gap;
            return deltaAt(at, {
              messageCount: step.messages,
              liveCount: step.messages,
              bytesTotal: step.bytes,
              maxPayloadSize: step.bytes,
              interArrival: observeValue(EMPTY_DISTRIBUTION, step.gap),
            });
          });
          const split = Math.min(splitAt, deltas.length - 1);

          const sequential = fold(deltas);
          const merged = mergeRecords(fold(deltas.slice(0, split)), fold(deltas.slice(split)));

          expect(merged.messageCount).toBe(sequential.messageCount);
          expect(merged.bytesTotal).toBe(sequential.bytesTotal);
          expect(merged.maxPayloadSize).toBe(sequential.maxPayloadSize);
          expect(merged.firstSeenAt).toBe(sequential.firstSeenAt);
          expect(merged.lastSeenAt).toBe(sequential.lastSeenAt);
          expect(merged.interArrival.count).toBe(sequential.interArrival.count);
          expect(merged.interArrival.mean).toBeCloseTo(sequential.interArrival.mean, 6);
          expect(merged.rate.perSecond).toBeCloseTo(sequential.rate.perSecond, 6);
        },
      ),
    );
  });
});

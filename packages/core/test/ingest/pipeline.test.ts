/**
 * The ingest pipeline, driven by a fake clock.
 *
 * The properties worth protecting are the promises made to an agent: counts are exact, the
 * last message is exact, denied topics never reach storage, and every bound that is hit is
 * reported rather than hidden.
 */
import { describe, expect, it } from 'vitest';
import type { InboundMessage, ReadPolicy, TopicCatalog } from '../../src/index.js';
import {
  createReadPolicy,
  IngestPipeline,
  MemoryMessageStore,
  MemoryTopicCatalog,
  parseBrokerId,
  parseTopicFilter,
  parseTopicName,
} from '../../src/index.js';
import { FakeClock, InMemoryMetricsRecorder } from '../../src/testing/index.js';

const BROKER = parseBrokerId('factory-fr');
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function message(topic: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    topic,
    payload: utf8('{"ready":true}'),
    qos: 0,
    retain: false,
    dup: false,
    ...overrides,
  };
}

function harness(
  options: {
    policy?: ReadPolicy;
    limits?: Partial<ConstructorParameters<typeof IngestPipeline>[0]['limits']>;
    catalog?: TopicCatalog;
    messageStore?: MemoryMessageStore;
  } = {},
) {
  const clock = new FakeClock();
  const metrics = new InMemoryMetricsRecorder();
  const catalog = options.catalog ?? new MemoryTopicCatalog();
  const messageStore = options.messageStore ?? new MemoryMessageStore();
  const pipeline = new IngestPipeline({
    brokerId: BROKER,
    policy: options.policy ?? createReadPolicy({ allow: [parseTopicFilter('#')], deny: [] }),
    catalog,
    messageStore,
    clock,
    metrics,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return { pipeline, clock, catalog, messageStore, metrics };
}

describe('counting', () => {
  it('counts every message, and writes the totals on flush', async () => {
    const { pipeline, catalog } = harness();

    for (let index = 0; index < 100; index += 1) {
      pipeline.accept(message('factory/line-01/robot/status'));
    }
    await pipeline.flush();
    const record = await catalog.get(BROKER, parseTopicName('factory/line-01/robot/status'));

    expect(record?.messageCount).toBe(100);
    expect(pipeline.counters.received).toBe(100);
  });

  it('separates a retained replay from a live message', async () => {
    const { pipeline, catalog } = harness();

    pipeline.accept(message('factory/state', { retain: true }));
    pipeline.accept(message('factory/state'));
    await pipeline.flush();
    const record = await catalog.get(BROKER, parseTopicName('factory/state'));

    expect(record?.messageCount).toBe(2);
    expect(record?.retainedReplayCount).toBe(1);
    expect(record?.retainedState).toBe('present');
  });

  it('reads an empty retained payload as a cleared retained message', async () => {
    const { pipeline, catalog } = harness();

    pipeline.accept(message('factory/state', { retain: true, payload: new Uint8Array() }));
    await pipeline.flush();

    expect((await catalog.get(BROKER, parseTopicName('factory/state')))?.retainedState).toBe(
      'cleared',
    );
  });

  it('counts delivered QoS as it arrives', async () => {
    const { pipeline, catalog } = harness();

    pipeline.accept(message('a', { qos: 0 }));
    pipeline.accept(message('a', { qos: 1 }));
    pipeline.accept(message('a', { qos: 1 }));
    await pipeline.flush();

    expect((await catalog.get(BROKER, parseTopicName('a')))?.qosCounts).toEqual([1, 2, 0]);
  });

  it('measures intervals between live messages, across flushes', async () => {
    const { pipeline, clock, catalog } = harness();

    pipeline.accept(message('a'));
    await clock.advance(1000);
    pipeline.accept(message('a'));
    await pipeline.flush();
    await clock.advance(1000);
    pipeline.accept(message('a'));
    await pipeline.flush();

    const record = await catalog.get(BROKER, parseTopicName('a'));
    expect(record?.interArrival.count).toBe(2);
    expect(record?.interArrival.mean).toBeCloseTo(1000, 5);
  });
});

describe('the read policy is enforced on arrival', () => {
  it('never counts nor stores a denied topic', async () => {
    const { pipeline, catalog, messageStore, metrics } = harness({
      policy: createReadPolicy({
        allow: [parseTopicFilter('#')],
        deny: [parseTopicFilter('factory/+/secrets/#')],
      }),
    });

    pipeline.accept(message('factory/line-01/secrets/token', { payload: utf8('hunter2') }));
    pipeline.accept(message('factory/line-01/robot/status'));
    await pipeline.flush();

    expect(
      await catalog.get(BROKER, parseTopicName('factory/line-01/secrets/token')),
    ).toBeUndefined();
    expect(
      await messageStore.recent(BROKER, parseTopicName('factory/line-01/secrets/token'), 10),
    ).toEqual([]);
    expect((await catalog.stats(BROKER)).topicCount).toBe(1);
    expect(pipeline.counters.denied).toBe(1);
    expect(metrics.total('mqtt_intelligence.messages.denied')).toBe(1);
  });

  it('refuses a topic MQTT itself forbids', async () => {
    const { pipeline, catalog } = harness();

    pipeline.accept(message('bad\u0000topic'));
    await pipeline.flush();

    expect(pipeline.counters.invalidTopics).toBe(1);
    expect((await catalog.stats(BROKER)).topicCount).toBe(0);
  });
});

describe('what is kept', () => {
  it('keeps the last message of each topic, exactly', async () => {
    const { pipeline, messageStore } = harness();

    pipeline.accept(message('a', { payload: utf8('first') }));
    pipeline.accept(message('a', { payload: utf8('second') }));
    pipeline.accept(message('a', { payload: utf8('last') }));
    await pipeline.flush();
    const recent = await messageStore.recent(BROKER, parseTopicName('a'), 10);

    // One payload per topic per flush: the one an agent asks for is the latest.
    expect(recent).toHaveLength(1);
    expect(new TextDecoder().decode(recent[0]?.payload.bytes)).toBe('last');
  });

  it('classifies what it keeps', async () => {
    const { pipeline, messageStore, catalog } = harness();

    pipeline.accept(message('a', { payload: utf8('{"ready":true}') }));
    await pipeline.flush();

    expect(
      (await messageStore.recent(BROKER, parseTopicName('a'), 1))[0]?.payload.classification,
    ).toEqual({ kind: 'json', jsonType: 'object' });
    expect((await catalog.get(BROKER, parseTopicName('a')))?.payloadKinds).toEqual({ json: 1 });
  });

  it('truncates a stored payload, while reporting its published size', async () => {
    const { pipeline, messageStore } = harness({ limits: { maxStoredPayloadBytes: 4 } });

    pipeline.accept(message('a', { payload: utf8('0123456789') }));
    await pipeline.flush();
    const stored = (await messageStore.recent(BROKER, parseTopicName('a'), 1))[0];

    expect(stored?.payload.size).toBe(10);
    expect(stored?.payload.bytes.byteLength).toBe(4);
    expect(stored?.payload.truncated).toBe(true);
  });

  it('copies the payload rather than referencing the network buffer', async () => {
    const { pipeline, messageStore } = harness();
    const payload = utf8('original');

    pipeline.accept(message('a', { payload }));
    await pipeline.flush();
    payload.fill(0x21);
    const stored = (await messageStore.recent(BROKER, parseTopicName('a'), 1))[0];

    expect(new TextDecoder().decode(stored?.payload.bytes)).toBe('original');
  });

  it('stops classifying once the flush budget is spent, and says so', async () => {
    const { pipeline, catalog } = harness({ limits: { inspectionsPerFlush: 2 } });

    pipeline.accept(message('a'));
    pipeline.accept(message('b'));
    pipeline.accept(message('c'));
    await pipeline.flush();

    expect(pipeline.counters.notInspected).toBe(1);
    const inspected = await Promise.all(
      ['a', 'b', 'c'].map(
        async (topic) => (await catalog.get(BROKER, parseTopicName(topic)))?.inspectedCount,
      ),
    );
    expect(inspected.filter((count) => count === 1)).toHaveLength(2);
  });

  it('drops payloads rather than memory when the pending budget is full, and counts them', async () => {
    const { pipeline, metrics } = harness({ limits: { pendingPayloadMaxBytes: 16 } });

    for (let index = 0; index < 10; index += 1) {
      pipeline.accept(message(`topic/${String(index)}`, { payload: utf8('0123456789') }));
    }
    await pipeline.flush();

    expect(pipeline.counters.payloadsDropped).toBeGreaterThan(0);
    expect(metrics.total('mqtt_intelligence.payloads.dropped')).toBe(
      pipeline.counters.payloadsDropped,
    );
  });

  it('counts a topic whose payload was dropped', async () => {
    const { pipeline, catalog } = harness({ limits: { pendingPayloadMaxBytes: 1 } });

    pipeline.accept(message('a', { payload: utf8('0123456789') }));
    pipeline.accept(message('b', { payload: utf8('0123456789') }));
    await pipeline.flush();

    // Counting is exact even when nothing could be kept: the catalog still knows the topic.
    expect((await catalog.stats(BROKER)).topicCount).toBe(2);
    expect((await catalog.get(BROKER, parseTopicName('b')))?.messageCount).toBe(1);
  });
});

describe('the flush cycle', () => {
  it('flushes on its own once started', async () => {
    const { pipeline, clock, catalog } = harness({ limits: { flushIntervalMs: 100 } });
    pipeline.start();

    pipeline.accept(message('a'));
    expect((await catalog.stats(BROKER)).topicCount).toBe(0);
    await clock.advance(100);

    expect((await catalog.stats(BROKER)).topicCount).toBe(1);
    await pipeline.stop();
  });

  it('keeps flushing', async () => {
    const { pipeline, clock, catalog } = harness({ limits: { flushIntervalMs: 100 } });
    pipeline.start();

    pipeline.accept(message('a'));
    await clock.advance(100);
    pipeline.accept(message('b'));
    await clock.advance(100);

    expect((await catalog.stats(BROKER)).topicCount).toBe(2);
    await pipeline.stop();
  });

  it('writes what is pending when it stops', async () => {
    const { pipeline, clock, catalog } = harness();
    pipeline.start();
    pipeline.accept(message('a'));

    await pipeline.stop();
    await clock.advance(1000);

    expect((await catalog.stats(BROKER)).topicCount).toBe(1);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('keeps counting when a flush fails', async () => {
    // A store that is down must not stop the engine from counting.
    const failing: TopicCatalog = {
      applyBatch: () => Promise.reject(new Error('store unavailable')),
      get: () => Promise.resolve(undefined),
      query: () => Promise.resolve({ items: [] }),
      tree: () =>
        Promise.resolve({
          segment: '',
          path: '',
          topicCount: 0,
          messageCount: 0,
          isTopic: false,
          children: [],
          truncatedChildren: 0,
        }),
      stats: (brokerId) =>
        Promise.resolve({
          brokerId,
          topicCount: 0,
          messageCount: 0,
          bytesTotal: 0,
          evictedTopics: 0,
          ignoredTopics: 0,
        }),
    };
    const { pipeline, clock } = harness({ catalog: failing, limits: { flushIntervalMs: 100 } });
    pipeline.start();

    pipeline.accept(message('a'));
    await clock.advance(100);
    pipeline.accept(message('b'));

    expect(pipeline.counters.received).toBe(2);
    await clock.advance(100);
  });
});

describe('a burst', () => {
  it('stays bounded, and keeps its counts exact, over 100,000 messages on 10,000 topics', async () => {
    const catalog = new MemoryTopicCatalog({ maxTopicsPerBroker: 5000 });
    const messageStore = new MemoryMessageStore({ messagesPerTopic: 2, maxBytes: 1024 * 1024 });
    const { pipeline, clock } = harness({
      catalog,
      messageStore,
      limits: { flushIntervalMs: 100, inspectionsPerFlush: 500, pendingPayloadMaxBytes: 64 * 1024 },
    });
    pipeline.start();

    const payload = utf8('{"value":123456789}');
    for (let index = 0; index < 100_000; index += 1) {
      pipeline.accept(message(`devices/device-${String(index % 10_000)}/telemetry`, { payload }));
      if (index % 10_000 === 0) {
        await clock.advance(100);
      }
    }
    await pipeline.stop();

    const stats = await catalog.stats(BROKER);
    const storeStats = await messageStore.stats();

    // Every message was counted, even those whose topic was later evicted.
    expect(pipeline.counters.received).toBe(100_000);
    expect(pipeline.counters.denied).toBe(0);
    // And every bound held.
    expect(stats.topicCount).toBe(5000);
    expect(stats.evictedTopics).toBeGreaterThan(0);
    expect(storeStats.bytesStored).toBeLessThanOrEqual(1024 * 1024);
    expect(pipeline.counters.payloadsDropped + pipeline.counters.notInspected).toBeGreaterThan(0);
  }, 60_000);
});

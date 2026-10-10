/**
 * The behaviour every storage implementation must have (ADR-0008).
 *
 * This suite, not the in-memory classes, is the definition of a `TopicCatalog` and a
 * `MessageStore`. A SQLite, Redis or PostgreSQL adapter is correct when it passes this, which
 * is what makes "storage is swappable" a fact rather than an intention.
 *
 * The test framework is injected, so the published package never depends on one.
 */
import type { BrokerId } from '../domain/ids.js';
import { parseBrokerId } from '../domain/ids.js';
import type { TopicName } from '../domain/topic.js';
import { parseTopicFilter, parseTopicName } from '../domain/topic.js';
import type { TopicCatalog, TopicDelta } from '../catalog/index.js';
import type { MessageStore, ObservedMessage } from '../store/index.js';

/** The slice of a test framework the contract needs. */
export interface ContractHarness {
  describe: (name: string, body: () => void) => void;
  it: (name: string, body: () => void | Promise<void>) => void;
  expect: (actual: unknown) => {
    toEqual: (expected: unknown) => void;
    toBe: (expected: unknown) => void;
  };
}

export const CONTRACT_BROKER: BrokerId = parseBrokerId('contract-broker');
const OTHER_BROKER: BrokerId = parseBrokerId('other-broker');

export function topicDelta(topic: string, overrides: Partial<TopicDelta> = {}): TopicDelta {
  const at = overrides.lastSeenAt ?? 1_000_000;
  return {
    topic: parseTopicName(topic),
    firstSeenAt: overrides.firstSeenAt ?? at,
    lastSeenAt: at,
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

export function observedMessage(
  topic: string,
  overrides: Partial<ObservedMessage> = {},
): ObservedMessage {
  return {
    brokerId: CONTRACT_BROKER,
    topic: parseTopicName(topic),
    receivedAt: 1_000_000,
    sequence: 1,
    deliveredQos: 0,
    retainFlag: false,
    retainedReplay: false,
    payload: {
      size: 4,
      bytes: new Uint8Array([1, 2, 3, 4]),
      truncated: false,
      classification: { kind: 'binary' },
    },
    ...overrides,
  };
}

/** Runs the `TopicCatalog` contract against an implementation. */
export function topicCatalogContract(
  harness: ContractHarness,
  createCatalog: () => TopicCatalog,
): void {
  const { describe, it, expect } = harness;

  describe('TopicCatalog contract', () => {
    it('creates a record from the first delta', async () => {
      const catalog = createCatalog();

      const result = await catalog.applyBatch(CONTRACT_BROKER, [
        topicDelta('factory/line-01/robot/status'),
      ]);
      const record = await catalog.get(
        CONTRACT_BROKER,
        parseTopicName('factory/line-01/robot/status'),
      );

      expect(result.applied).toBe(1);
      expect(record?.messageCount).toBe(1);
      expect(record?.brokerId).toBe(CONTRACT_BROKER);
    });

    it('folds further deltas into the same record', async () => {
      const catalog = createCatalog();
      const topic = 'factory/line-01/robot/status';

      await catalog.applyBatch(CONTRACT_BROKER, [
        topicDelta(topic, { firstSeenAt: 1000, lastSeenAt: 1000 }),
      ]);
      await catalog.applyBatch(CONTRACT_BROKER, [
        topicDelta(topic, { firstSeenAt: 2000, lastSeenAt: 2000, messageCount: 3, bytesTotal: 30 }),
      ]);
      const record = await catalog.get(CONTRACT_BROKER, parseTopicName(topic));

      expect(record?.messageCount).toBe(4);
      expect(record?.bytesTotal).toBe(40);
      expect(record?.firstSeenAt).toBe(1000);
      expect(record?.lastSeenAt).toBe(2000);
    });

    it('keeps brokers apart', async () => {
      const catalog = createCatalog();
      const topic = 'shared/topic';

      await catalog.applyBatch(CONTRACT_BROKER, [topicDelta(topic)]);
      await catalog.applyBatch(OTHER_BROKER, [topicDelta(topic, { messageCount: 7 })]);

      expect((await catalog.get(CONTRACT_BROKER, parseTopicName(topic)))?.messageCount).toBe(1);
      expect((await catalog.get(OTHER_BROKER, parseTopicName(topic)))?.messageCount).toBe(7);
    });

    it('returns nothing for a topic it never saw', async () => {
      const catalog = createCatalog();

      expect(await catalog.get(CONTRACT_BROKER, parseTopicName('never/seen'))).toBe(undefined);
    });

    it('filters a query by MQTT filter, text and payload kind', async () => {
      const catalog = createCatalog();
      await catalog.applyBatch(CONTRACT_BROKER, [
        topicDelta('factory/line-01/robot'),
        topicDelta('factory/line-02/robot'),
        topicDelta('plant/pump', { payloadKinds: { text: 1 } }),
      ]);

      const byFilter = await catalog.query({ filter: parseTopicFilter('factory/#') });
      const byText = await catalog.query({ text: 'line-02' });
      const byKind = await catalog.query({ payloadKind: 'text' });

      expect(byFilter.items.length).toBe(2);
      expect(byText.items.map((record) => record.topic)).toEqual(['factory/line-02/robot']);
      expect(byKind.items.map((record) => record.topic)).toEqual(['plant/pump']);
    });

    it('sorts, and pages through every record exactly once', async () => {
      const catalog = createCatalog();
      await catalog.applyBatch(
        CONTRACT_BROKER,
        Array.from({ length: 10 }, (_item, index) =>
          topicDelta(`topic/${String(index).padStart(2, '0')}`),
        ),
      );

      const seen: TopicName[] = [];
      let cursor: string | undefined;
      do {
        const page = await catalog.query({
          sortBy: 'topic',
          limit: 3,
          ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...page.items.map((record) => record.topic));
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      expect(seen.length).toBe(10);
      expect(new Set(seen).size).toBe(10);
      expect(seen[0]).toBe('topic/00');
      expect(seen[9]).toBe('topic/09');
    });

    it('sorts by message count, descending', async () => {
      const catalog = createCatalog();
      await catalog.applyBatch(CONTRACT_BROKER, [
        topicDelta('quiet', { messageCount: 1 }),
        topicDelta('busy', { messageCount: 100 }),
        topicDelta('medium', { messageCount: 10 }),
      ]);

      const page = await catalog.query({ sortBy: 'messageCount', descending: true });

      expect(page.items.map((record) => record.topic)).toEqual(['busy', 'medium', 'quiet']);
    });

    it('separates active topics from silent ones', async () => {
      const catalog = createCatalog();
      await catalog.applyBatch(CONTRACT_BROKER, [
        topicDelta('recent', { lastSeenAt: 5000, lastLiveAt: 5000 }),
        topicDelta('stale', { lastSeenAt: 1000, lastLiveAt: 1000 }),
      ]);

      const active = await catalog.query({ activeSince: 2000 });
      const silent = await catalog.query({ silentSince: 2000 });

      expect(active.items.map((record) => record.topic)).toEqual(['recent']);
      expect(silent.items.map((record) => record.topic)).toEqual(['stale']);
    });

    it('aggregates a tree, counting every topic below a node', async () => {
      const catalog = createCatalog();
      await catalog.applyBatch(CONTRACT_BROKER, [
        topicDelta('factory/line-01/robot/status', { messageCount: 2 }),
        topicDelta('factory/line-01/robot/error'),
        topicDelta('factory/line-02/plc/state'),
      ]);

      const tree = await catalog.tree({ brokerId: CONTRACT_BROKER, depth: 2 });

      expect(tree.topicCount).toBe(3);
      expect(tree.messageCount).toBe(4);
      const factory = tree.children[0];
      expect(factory?.segment).toBe('factory');
      expect(factory?.children.map((child) => child.segment)).toEqual(['line-01', 'line-02']);
      expect(factory?.children[0]?.topicCount).toBe(2);
    });

    it('starts a tree from a root, and stops at the requested depth', async () => {
      const catalog = createCatalog();
      await catalog.applyBatch(CONTRACT_BROKER, [
        topicDelta('factory/line-01/robot/status'),
        topicDelta('plant/pump'),
      ]);

      const tree = await catalog.tree({ root: ['factory', 'line-01'], depth: 1 });

      expect(tree.path).toBe('factory/line-01');
      expect(tree.topicCount).toBe(1);
      expect(tree.children.map((child) => child.segment)).toEqual(['robot']);
      expect(tree.children[0]?.children).toEqual([]);
    });

    it('marks a node that is itself a topic', async () => {
      const catalog = createCatalog();
      await catalog.applyBatch(CONTRACT_BROKER, [
        topicDelta('factory/line-01'),
        topicDelta('factory/line-01/robot'),
      ]);

      const tree = await catalog.tree({ depth: 3 });
      const line = tree.children[0]?.children[0];

      expect(line?.isTopic).toBe(true);
      expect(line?.children[0]?.isTopic).toBe(true);
      expect(tree.children[0]?.isTopic).toBe(false);
    });

    it('reports its own size', async () => {
      const catalog = createCatalog();
      await catalog.applyBatch(CONTRACT_BROKER, [
        topicDelta('a', { bytesTotal: 100 }),
        topicDelta('b', { bytesTotal: 50, messageCount: 2 }),
      ]);

      const stats = await catalog.stats(CONTRACT_BROKER);

      expect(stats.topicCount).toBe(2);
      expect(stats.messageCount).toBe(3);
      expect(stats.bytesTotal).toBe(150);
    });

    it('reports an empty broker without inventing one', async () => {
      const catalog = createCatalog();

      const stats = await catalog.stats(CONTRACT_BROKER);

      expect(stats.topicCount).toBe(0);
      expect(stats.evictedTopics).toBe(0);
    });
  });
}

/** Runs the `MessageStore` contract against an implementation. */
export function messageStoreContract(
  harness: ContractHarness,
  createStore: () => MessageStore,
): void {
  const { describe, it, expect } = harness;

  describe('MessageStore contract', () => {
    it('returns the most recent messages first', async () => {
      const store = createStore();
      await store.append([
        observedMessage('factory/robot', { receivedAt: 1000, sequence: 1 }),
        observedMessage('factory/robot', { receivedAt: 2000, sequence: 2 }),
        observedMessage('factory/robot', { receivedAt: 3000, sequence: 3 }),
      ]);

      const recent = await store.recent(CONTRACT_BROKER, parseTopicName('factory/robot'), 2);

      expect(recent.map((message) => message.sequence)).toEqual([3, 2]);
    });

    it('returns nothing for a topic it never saw', async () => {
      const store = createStore();

      expect(await store.recent(CONTRACT_BROKER, parseTopicName('never/seen'), 5)).toEqual([]);
    });

    it('keeps topics and brokers apart', async () => {
      const store = createStore();
      await store.append([
        observedMessage('a', { sequence: 1 }),
        observedMessage('b', { sequence: 2 }),
        observedMessage('a', { brokerId: OTHER_BROKER, sequence: 3 }),
      ]);

      const first = await store.recent(CONTRACT_BROKER, parseTopicName('a'), 10);
      const other = await store.recent(OTHER_BROKER, parseTopicName('a'), 10);

      expect(first.map((message) => message.sequence)).toEqual([1]);
      expect(other.map((message) => message.sequence)).toEqual([3]);
    });

    it('queries by filter and time range', async () => {
      const store = createStore();
      await store.append([
        observedMessage('factory/a', { receivedAt: 1000, sequence: 1 }),
        observedMessage('factory/b', { receivedAt: 2000, sequence: 2 }),
        observedMessage('plant/c', { receivedAt: 3000, sequence: 3 }),
      ]);

      const byFilter = await store.query({ filter: parseTopicFilter('factory/#') });
      const byTime = await store.query({ from: 2000, to: 3000 });

      expect(byFilter.items.map((message) => message.sequence)).toEqual([2, 1]);
      expect(byTime.items.map((message) => message.sequence)).toEqual([2]);
    });

    it('pages through a query exactly once, oldest first when asked', async () => {
      const store = createStore();
      await store.append(
        Array.from({ length: 7 }, (_item, index) =>
          observedMessage('factory/a', { receivedAt: 1000 + index, sequence: index + 1 }),
        ),
      );

      const seen: number[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.query({
          ascending: true,
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...page.items.map((message) => message.sequence));
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('reports what it holds', async () => {
      const store = createStore();
      await store.append([observedMessage('a'), observedMessage('b')]);

      const stats = await store.stats();

      expect(stats.messageCount).toBe(2);
      expect(stats.topicCount).toBe(2);
      expect(stats.bytesStored).toBe(8);
    });
  });
}

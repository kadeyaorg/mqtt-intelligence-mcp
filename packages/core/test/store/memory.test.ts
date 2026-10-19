/**
 * The memory stores, verified twice: once by the shared contract every implementation must
 * pass, and once on what is specific to holding everything in memory — the bounds.
 */
import { describe, expect, it } from 'vitest';
import {
  MemoryMessageStore,
  MemoryTopicCatalog,
  parseBrokerId,
  parseTopicName,
} from '../../src/index.js';
import {
  CONTRACT_BROKER,
  messageStoreContract,
  observedMessage,
  topicCatalogContract,
  topicDelta,
} from '../../src/testing/index.js';

const harness = { describe, it, expect };

topicCatalogContract(harness, () => new MemoryTopicCatalog());
messageStoreContract(harness, () => new MemoryMessageStore());

const BROKER = parseBrokerId('factory-fr');

describe('MemoryTopicCatalog bounds', () => {
  it('evicts the least recently updated topic when full, and counts it', async () => {
    const catalog = new MemoryTopicCatalog({ maxTopicsPerBroker: 2 });

    await catalog.applyBatch(BROKER, [topicDelta('a'), topicDelta('b')]);
    // Touching "a" makes "b" the least recently updated one.
    await catalog.applyBatch(BROKER, [topicDelta('a')]);
    const result = await catalog.applyBatch(BROKER, [topicDelta('c')]);
    const stats = await catalog.stats(BROKER);

    expect(result.evicted).toBe(1);
    expect(stats.topicCount).toBe(2);
    expect(stats.evictedTopics).toBe(1);
    expect(await catalog.get(BROKER, parseTopicName('b'))).toBeUndefined();
    expect(await catalog.get(BROKER, parseTopicName('a'))).toBeDefined();
    expect(await catalog.get(BROKER, parseTopicName('c'))).toBeDefined();
  });

  it('can refuse new topics instead of evicting known ones', async () => {
    const catalog = new MemoryTopicCatalog({ maxTopicsPerBroker: 1, onTopicLimit: 'ignore-new' });

    await catalog.applyBatch(BROKER, [topicDelta('a')]);
    const result = await catalog.applyBatch(BROKER, [topicDelta('b')]);
    const stats = await catalog.stats(BROKER);

    expect(result).toEqual({ applied: 0, evicted: 0, ignored: 1 });
    expect(stats.ignoredTopics).toBe(1);
    expect(await catalog.get(BROKER, parseTopicName('a'))).toBeDefined();
    expect(await catalog.get(BROKER, parseTopicName('b'))).toBeUndefined();
  });

  it('keeps updating a known topic once the limit is reached', async () => {
    const catalog = new MemoryTopicCatalog({ maxTopicsPerBroker: 1, onTopicLimit: 'ignore-new' });
    await catalog.applyBatch(BROKER, [topicDelta('a')]);

    await catalog.applyBatch(BROKER, [topicDelta('a', { messageCount: 5 })]);

    expect((await catalog.get(BROKER, parseTopicName('a')))?.messageCount).toBe(6);
  });

  it('limits how many children a tree lists, and says how many it left out', async () => {
    const catalog = new MemoryTopicCatalog();
    await catalog.applyBatch(
      BROKER,
      Array.from({ length: 10 }, (_item, index) => topicDelta(`devices/device-${String(index)}`)),
    );

    // Folding off: this is about truncation, and ten device branches would otherwise fold
    // into one, which the test below covers on its own.
    const tree = await catalog.tree({
      brokerId: BROKER,
      depth: 2,
      maxChildren: 3,
      foldPatterns: false,
    });

    expect(tree.children[0]?.children).toHaveLength(3);
    expect(tree.children[0]?.truncatedChildren).toBe(7);
    // The count still covers everything below, even what is not listed.
    expect(tree.children[0]?.topicCount).toBe(10);
  });

  it('folds instead of truncating, so a device-keyed namespace stays whole', async () => {
    const catalog = new MemoryTopicCatalog();
    await catalog.applyBatch(
      BROKER,
      Array.from({ length: 10 }, (_item, index) => topicDelta(`devices/device-${String(index)}`)),
    );

    const tree = await catalog.tree({ brokerId: BROKER, depth: 2, maxChildren: 3 });
    const devices = tree.children[0];

    // One shape rather than three branches and a promise that seven more exist.
    expect(devices?.children).toHaveLength(1);
    expect(devices?.children[0]?.segment).toBe('device-#');
    expect(devices?.children[0]?.foldedBranches).toBe(10);
    expect(devices?.truncatedChildren).toBe(0);
  });

  it('caps the page size a caller can ask for', async () => {
    const catalog = new MemoryTopicCatalog({ maxLimit: 2 });
    await catalog.applyBatch(
      BROKER,
      Array.from({ length: 5 }, (_item, index) => topicDelta(`t/${String(index)}`)),
    );

    const page = await catalog.query({ limit: 1000 });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeDefined();
  });

  it('starts from the beginning when a cursor is unreadable', async () => {
    const catalog = new MemoryTopicCatalog();
    await catalog.applyBatch(BROKER, [topicDelta('a'), topicDelta('b')]);

    const page = await catalog.query({ cursor: 'not-a-cursor' });

    expect(page.items).toHaveLength(2);
  });

  it('queries across brokers when none is named', async () => {
    const catalog = new MemoryTopicCatalog();
    await catalog.applyBatch(BROKER, [topicDelta('a')]);
    await catalog.applyBatch(parseBrokerId('staging'), [topicDelta('b')]);

    const all = await catalog.query({});
    const one = await catalog.query({ brokerId: BROKER });

    expect(all.items).toHaveLength(2);
    expect(one.items.map((record) => record.topic)).toEqual(['a']);
  });
});

describe('MemoryMessageStore bounds', () => {
  it('keeps only the newest messages of a topic', async () => {
    const store = new MemoryMessageStore({ messagesPerTopic: 2 });

    await store.append([
      observedMessage('a', { sequence: 1 }),
      observedMessage('a', { sequence: 2 }),
      observedMessage('a', { sequence: 3 }),
    ]);
    const recent = await store.recent(CONTRACT_BROKER, parseTopicName('a'), 10);
    const stats = await store.stats();

    expect(recent.map((message) => message.sequence)).toEqual([3, 2]);
    expect(stats.evictedMessages).toBe(1);
    expect(stats.messageCount).toBe(2);
  });

  it('a chatty topic cannot push another topic out of its own ring', async () => {
    const store = new MemoryMessageStore({ messagesPerTopic: 2 });

    await store.append([
      observedMessage('quiet', { sequence: 1 }),
      ...Array.from({ length: 10 }, (_item, index) =>
        observedMessage('chatty', { sequence: index + 2 }),
      ),
    ]);

    expect(await store.recent(CONTRACT_BROKER, parseTopicName('quiet'), 10)).toHaveLength(1);
    expect(await store.recent(CONTRACT_BROKER, parseTopicName('chatty'), 10)).toHaveLength(2);
  });

  it('drops the globally oldest messages to respect the byte budget', async () => {
    const store = new MemoryMessageStore({ maxBytes: 12, messagesPerTopic: 100 });

    // Four bytes each: the budget holds three.
    await store.append([
      observedMessage('a', { sequence: 1 }),
      observedMessage('b', { sequence: 2 }),
      observedMessage('c', { sequence: 3 }),
      observedMessage('d', { sequence: 4 }),
    ]);
    const stats = await store.stats();

    expect(stats.bytesStored).toBe(12);
    expect(stats.evictedMessages).toBe(1);
    expect(await store.recent(CONTRACT_BROKER, parseTopicName('a'), 10)).toEqual([]);
    expect(await store.recent(CONTRACT_BROKER, parseTopicName('d'), 10)).toHaveLength(1);
  });

  it('forgets a topic whose last message was evicted', async () => {
    const store = new MemoryMessageStore({ maxBytes: 4, messagesPerTopic: 100 });

    await store.append([observedMessage('a', { sequence: 1 })]);
    await store.append([observedMessage('b', { sequence: 2 })]);
    const stats = await store.stats();

    expect(stats.topicCount).toBe(1);
    expect(stats.messageCount).toBe(1);
  });

  it('caps the page size a caller can ask for', async () => {
    const store = new MemoryMessageStore({ maxLimit: 2 });
    await store.append(
      Array.from({ length: 5 }, (_item, index) =>
        observedMessage('a', { sequence: index + 1, receivedAt: 1000 + index }),
      ),
    );

    const page = await store.query({ limit: 1000 });

    expect(page.items).toHaveLength(2);
  });
});

describe('folding sibling branches that share a shape', () => {
  async function catalogWith(topics: readonly string[]): Promise<MemoryTopicCatalog> {
    const catalog = new MemoryTopicCatalog();
    await catalog.applyBatch(
      CONTRACT_BROKER,
      topics.map((topic) => topicDelta(parseTopicName(topic))),
    );
    return catalog;
  }

  it('folds branches that differ only in a number', async () => {
    // Straight from a real line: four filling stations under one machine.
    const catalog = await catalogWith([
      'plc/dispense/f1',
      'plc/dispense/f2',
      'plc/dispense/f3',
      'plc/dispense/f4',
      'plc/dispense/state',
    ]);

    const tree = await catalog.tree({ brokerId: CONTRACT_BROKER, depth: 3 });
    const dispense = tree.children[0]?.children[0];
    const segments = dispense?.children.map((child) => child.segment) ?? [];

    expect(segments).toContain('f#');
    expect(segments).toContain('state');
    expect(dispense?.children.find((child) => child.segment === 'f#')?.foldedBranches).toBe(4);
    // The fold aggregates what it folded rather than hiding it.
    expect(dispense?.children.find((child) => child.segment === 'f#')?.topicCount).toBe(4);
  });

  it('leaves two siblings alone, because two is not a pattern', async () => {
    const catalog = await catalogWith(['plc/washer/f1', 'plc/washer/f2']);

    const tree = await catalog.tree({ brokerId: CONTRACT_BROKER, depth: 3 });
    const segments = tree.children[0]?.children[0]?.children.map((child) => child.segment) ?? [];

    expect(segments.sort()).toEqual(['f1', 'f2']);
  });

  it('never folds siblings whose names have nothing variable in common', async () => {
    const catalog = await catalogWith(['plc/state', 'plc/safety', 'plc/outputs', 'plc/version']);

    const tree = await catalog.tree({ brokerId: CONTRACT_BROKER, depth: 2 });
    const segments = tree.children[0]?.children.map((child) => child.segment) ?? [];

    expect(segments.sort()).toEqual(['outputs', 'safety', 'state', 'version']);
  });

  it('folds device identifiers and keeps the subtree below them', async () => {
    const catalog = await catalogWith([
      'sensors/3f2504e0-4f89-11d3-9a0c-0305e82c3301/temp',
      'sensors/3f2504e0-4f89-11d3-9a0c-0305e82c3302/temp',
      'sensors/3f2504e0-4f89-11d3-9a0c-0305e82c3303/humidity',
    ]);

    const tree = await catalog.tree({ brokerId: CONTRACT_BROKER, depth: 3 });
    const folded = tree.children[0]?.children[0];

    expect(folded?.segment).toBe('<uuid>');
    expect(folded?.foldedBranches).toBe(3);
    // Everything under the folded branches is merged, not lost.
    expect(folded?.children.map((child) => child.segment).sort()).toEqual(['humidity', 'temp']);
  });

  it('shows every branch when folding is turned off', async () => {
    const catalog = await catalogWith(['plc/dispense/f1', 'plc/dispense/f2', 'plc/dispense/f3']);

    const tree = await catalog.tree({
      brokerId: CONTRACT_BROKER,
      depth: 3,
      foldPatterns: false,
    });
    const segments = tree.children[0]?.children[0]?.children.map((child) => child.segment) ?? [];

    expect(segments.sort()).toEqual(['f1', 'f2', 'f3']);
  });
});

describe('asking what is new', () => {
  it('keeps only the topics first seen at or after the instant', async () => {
    const catalog = new MemoryTopicCatalog();
    await catalog.applyBatch(BROKER, [
      topicDelta('old/one', { firstSeenAt: 1000, lastSeenAt: 9000 }),
      topicDelta('fresh/one', { firstSeenAt: 8000, lastSeenAt: 9000 }),
    ]);

    const page = await catalog.query({ brokerId: BROKER, firstSeenSince: 5000 });

    expect(page.items.map((record) => record.topic)).toEqual(['fresh/one']);
  });

  it('judges on first seen, not on recent traffic', async () => {
    const catalog = new MemoryTopicCatalog();
    await catalog.applyBatch(BROKER, [
      // Long-standing and busy: the opposite of new, however loudly it publishes.
      topicDelta('old/busy', { firstSeenAt: 1000, lastSeenAt: 9999 }),
    ]);

    const page = await catalog.query({ brokerId: BROKER, firstSeenSince: 5000 });

    expect(page.items).toHaveLength(0);
  });
});

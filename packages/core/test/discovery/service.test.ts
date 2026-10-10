/**
 * Discovery, and the coverage it must report.
 *
 * The assertions here are mostly about honesty: a refused filter is named, a disconnection
 * leaves a gap, and the time actually spent observing is what is reported — so that an agent
 * can tell "this topic stopped publishing" from "we were not listening".
 */
import { describe, expect, it } from 'vitest';
import type { BrokerConnectionOptions, ReadPolicy, TransportOptions } from '../../src/index.js';
import {
  BrokerConnection,
  createReadPolicy,
  DiscoveryService,
  IngestPipeline,
  MemoryMessageStore,
  MemoryTopicCatalog,
  parseBrokerId,
  parseTopicFilter,
  SubscriptionManager,
  SYSTEM_TOPIC_FILTER,
} from '../../src/index.js';
import { FakeClock, FakeTransportFactory } from '../../src/testing/index.js';

const BROKER = parseBrokerId('factory-fr');
const filter = parseTopicFilter;

const transport: TransportOptions = {
  url: 'mqtt://localhost:1883',
  protocolVersion: 5,
  clientId: 'mqtt-intel-test',
  keepaliveSeconds: 30,
  connectTimeoutMs: 5000,
};

const connectionOptions: BrokerConnectionOptions = {
  brokerId: BROKER,
  transport,
  reconnect: { initialDelayMs: 1000, maxDelayMs: 60_000 },
};

function harness(
  policy: ReadPolicy | undefined = createReadPolicy({ allow: [filter('#')], deny: [] }),
  options: { readonly catalog?: MemoryTopicCatalog } = {},
) {
  const clock = new FakeClock();
  const transports = new FakeTransportFactory();
  const catalog = options.catalog ?? new MemoryTopicCatalog();
  const messageStore = new MemoryMessageStore();
  const pipeline = new IngestPipeline({
    brokerId: BROKER,
    policy,
    catalog,
    messageStore,
    clock,
  });
  const connection = new BrokerConnection(connectionOptions, {
    transportFactory: transports,
    clock,
    // The composition root wires the transport to the pipeline; here the harness does.
    onMessage: (_brokerId, message) => {
      pipeline.accept(message);
    },
    // Deterministic backoff, so a disconnection lasts exactly as long as the test says.
    random: () => 1,
  });
  const subscriptions = new SubscriptionManager({ connection, policy });
  const discovery = new DiscoveryService({
    connection,
    subscriptions,
    catalog,
    pipeline,
    clock,
  });
  return { discovery, connection, subscriptions, pipeline, catalog, clock, transports };
}

describe('starting', () => {
  it('subscribes the configured filters and starts the pipeline', async () => {
    const { discovery, subscriptions, clock } = harness();

    await discovery.start({ filters: [filter('factory/#')] });
    const coverage = await discovery.coverage();

    expect(subscriptions.brokerFilters).toEqual(['factory/#']);
    expect(coverage.filters).toEqual(['factory/#']);
    expect(coverage.observingSince).toBe(clock.now());
    expect(discovery.started).toBe(true);
  });

  it('asks for $SYS only when told to, since "#" cannot reach it', async () => {
    const withoutSys = harness();
    await withoutSys.discovery.start({ filters: [filter('#')] });

    const withSys = harness(
      createReadPolicy({ allow: [filter('#'), SYSTEM_TOPIC_FILTER], deny: [] }),
    );
    await withSys.discovery.start({ filters: [filter('#')], includeSysTopics: true });

    expect(withoutSys.subscriptions.brokerFilters).toEqual(['#']);
    expect(withSys.subscriptions.brokerFilters).toEqual(['#', '$SYS/#']);
  });

  it('starts anyway when a filter is refused, and names it', async () => {
    const { discovery } = harness(
      createReadPolicy({ allow: [filter('factory/#')], deny: [filter('factory/secrets/#')] }),
    );

    await discovery.start({ filters: [filter('factory/#'), filter('factory/secrets/#')] });
    const coverage = await discovery.coverage();

    expect(coverage.filters).toEqual(['factory/#']);
    expect(coverage.rejectedFilters).toHaveLength(1);
    expect(coverage.rejectedFilters[0]?.filter).toBe('factory/secrets/#');
  });

  it('reports a filter the broker refused, with its reason', async () => {
    const { discovery, connection, transports } = harness();
    await connection.ensureConnected();
    transports.last.subscribeOutcomes.set('#', { granted: false, reasonCode: 0x87 });

    await discovery.start({ filters: [filter('#')] });
    const coverage = await discovery.coverage();

    expect(coverage.filters).toEqual([]);
    expect(coverage.rejectedFilters[0]?.reason).toContain('135');
  });

  it('does nothing when started twice', async () => {
    const { discovery, subscriptions } = harness();

    await discovery.start({ filters: [filter('#')] });
    await discovery.start({ filters: [filter('plant/#')] });

    expect(subscriptions.brokerFilters).toEqual(['#']);
  });
});

describe('coverage', () => {
  it('counts the time actually spent connected', async () => {
    const { discovery, connection, clock } = harness();
    await connection.ensureConnected();
    await discovery.start({ filters: [filter('#')] });

    await clock.advance(5000);
    const coverage = await discovery.coverage();

    expect(coverage.observedMs).toBe(5000);
    expect(coverage.gaps).toEqual([]);
  });

  it('records a gap while disconnected, and closes it on return', async () => {
    const { discovery, connection, clock, transports } = harness();
    await connection.ensureConnected();
    await discovery.start({ filters: [filter('#')] });
    await clock.advance(1000);

    const droppedAt = clock.now();
    transports.last.dropConnection();
    // Backoff is a full second here, so the gap is still open halfway through it.
    await clock.advance(500);
    const duringGap = await discovery.coverage();
    await clock.advance(500);
    const reconnectedAt = clock.now();
    await clock.advance(5000);
    const afterGap = await discovery.coverage();

    expect(duringGap.gaps).toEqual([{ from: droppedAt, reason: 'disconnected' }]);
    expect(afterGap.gaps[0]?.to).toBe(reconnectedAt);
    // Time spent disconnected is not time spent observing.
    expect(afterGap.observedMs).toBe(1000 + 5000);
  });

  it('opens with a gap when the broker cannot be reached at all', async () => {
    const { discovery, clock, transports } = harness();
    transports.connectBehaviour = { type: 'fail', error: new Error('ECONNREFUSED') };

    const startedAt = clock.now();
    await discovery.start({ filters: [filter('#')] });
    const coverage = await discovery.coverage();

    // Nothing was observed, and the answer says so rather than looking like an empty broker.
    expect(coverage.gaps).toEqual([{ from: startedAt, reason: 'not-started' }]);
    expect(coverage.observedMs).toBe(0);
    expect(coverage.topicCount).toBe(0);
  });

  it('reports what the ingest path had to drop or refuse', async () => {
    const { discovery, connection, pipeline, transports } = harness(
      createReadPolicy({ allow: [filter('#')], deny: [filter('secret/#')] }),
    );
    await connection.ensureConnected();
    await discovery.start({ filters: [filter('#')] });

    transports.last.deliver({ topic: 'secret/token', payload: new Uint8Array([1]) });
    transports.last.deliver({ topic: 'factory/robot', payload: new Uint8Array([1]) });
    await pipeline.flush();
    const coverage = await discovery.coverage();

    expect(coverage.deniedMessages).toBe(1);
    expect(coverage.topicCount).toBe(1);
    expect(coverage.messageCount).toBe(1);
  });

  it('reports topics the catalog had to evict', async () => {
    const { discovery, connection, pipeline, transports } = harness(undefined, {
      catalog: new MemoryTopicCatalog({ maxTopicsPerBroker: 1 }),
    });
    await connection.ensureConnected();
    await discovery.start({ filters: [filter('#')] });

    transports.last.deliver({ topic: 'a' });
    transports.last.deliver({ topic: 'b' });
    await pipeline.flush();
    const coverage = await discovery.coverage();

    expect(coverage.evictedTopics).toBe(1);
    expect(coverage.topicCount).toBe(1);
  });
});

describe('stopping', () => {
  it('releases its subscriptions and flushes what it had', async () => {
    const { discovery, connection, subscriptions, catalog, transports } = harness();
    await connection.ensureConnected();
    await discovery.start({ filters: [filter('#')] });
    transports.last.deliver({ topic: 'factory/robot' });

    await discovery.stop();

    expect(subscriptions.brokerFilters).toEqual([]);
    expect((await catalog.stats(BROKER)).topicCount).toBe(1);
    expect(discovery.started).toBe(false);
  });

  it('stops counting the time once stopped', async () => {
    const { discovery, connection, clock } = harness();
    await connection.ensureConnected();
    await discovery.start({ filters: [filter('#')] });
    await clock.advance(1000);

    await discovery.stop();
    await clock.advance(10_000);
    const coverage = await discovery.coverage();

    expect(coverage.observedMs).toBe(1000);
  });
});

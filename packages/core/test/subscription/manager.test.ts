/**
 * Leases and the minimal covering set.
 *
 * The behaviour under test is mostly about what is *not* sent to the broker: a filter
 * already covered by a broader one, a tree a lease no longer needs, a subscription a broker
 * already refused.
 */
import { describe, expect, it } from 'vitest';
import type { BrokerConnectionOptions, ReadPolicy, TransportOptions } from '../../src/index.js';
import {
  BrokerConnection,
  createReadPolicy,
  minimalCover,
  parseBrokerId,
  parseTopicFilter,
  parseTopicName,
  SubscriptionManager,
} from '../../src/index.js';
import {
  FakeClock,
  FakeTransportFactory,
  InMemoryMetricsRecorder,
} from '../../src/testing/index.js';

const BROKER = parseBrokerId('factory-fr');
const filter = parseTopicFilter;

const transportOptions: TransportOptions = {
  url: 'mqtt://localhost:1883',
  protocolVersion: 5,
  clientId: 'mqtt-intel-test',
  keepaliveSeconds: 30,
  connectTimeoutMs: 5000,
};

const connectionOptions: BrokerConnectionOptions = {
  brokerId: BROKER,
  transport: transportOptions,
  reconnect: { initialDelayMs: 1000, maxDelayMs: 60_000 },
};

function harness(policy: ReadPolicy = createReadPolicy({ allow: [filter('#')], deny: [] })) {
  const clock = new FakeClock();
  const transports = new FakeTransportFactory();
  const metrics = new InMemoryMetricsRecorder();
  const connection = new BrokerConnection(connectionOptions, {
    transportFactory: transports,
    clock,
  });
  const manager = new SubscriptionManager({ connection, policy, metrics });
  return { manager, connection, clock, transports, metrics };
}

describe('minimalCover', () => {
  it.each([
    ['drops a filter a broader one covers', ['#', 'factory/#', 'a/b'], ['#']],
    ['keeps filters that do not cover each other', ['a/#', 'b/#'], ['a/#', 'b/#']],
    ['removes duplicates', ['a/#', 'a/#'], ['a/#']],
    ['keeps a $ tree, which "#" cannot reach', ['#', '$SYS/#'], ['#', '$SYS/#']],
    ['keeps overlapping filters neither of which covers the other', ['a/+', '+/b'], ['a/+', '+/b']],
    ['drops an exact topic covered by a wildcard', ['a/+', 'a/b'], ['a/+']],
  ])('%s', (_case, input, expected) => {
    expect(minimalCover(input.map((value) => filter(value)))).toEqual(expected);
  });
});

describe('acquiring a lease', () => {
  it('subscribes what the lease asks for', async () => {
    const { manager, transports } = harness();

    const lease = await manager.acquire({
      filter: filter('factory/#'),
      qos: 1,
      owner: 'discovery',
    });

    expect(lease).toMatchObject({ owner: 'discovery', filter: 'factory/#', active: true });
    expect(manager.brokerFilters).toEqual(['factory/#']);
    expect(transports.last.subscriptions).toEqual([
      { filter: 'factory/#', options: { qos: 1, retainAsPublished: false } },
    ]);
  });

  it('does not subscribe a filter a broader lease already covers', async () => {
    const { manager, transports } = harness();
    await manager.acquire({ filter: filter('#'), qos: 0, owner: 'discovery' });

    const narrow = await manager.acquire({
      filter: filter('factory/line-01/#'),
      qos: 0,
      owner: 'capture:1',
    });

    expect(manager.brokerFilters).toEqual(['#']);
    expect(transports.last.subscribedFilters).toEqual(['#']);
    // Served by the broader subscription, so still active.
    expect(narrow.active).toBe(true);
  });

  it('replaces narrower subscriptions when a broader lease arrives', async () => {
    const { manager, transports } = harness();
    await manager.acquire({ filter: filter('factory/#'), qos: 0, owner: 'capture:1' });

    await manager.acquire({ filter: filter('#'), qos: 0, owner: 'discovery' });

    expect(manager.brokerFilters).toEqual(['#']);
    // Subscribed before unsubscribing, so no tree is ever momentarily unobserved.
    expect(transports.last.subscriptions.map((s) => s.filter)).toEqual(['#']);
    expect(transports.last.unsubscribed).toEqual(['factory/#']);
  });

  it('asks for the highest QoS any served lease requested', async () => {
    const { manager, transports } = harness();

    await manager.acquire({ filter: filter('#'), qos: 0, owner: 'discovery' });
    await manager.acquire({ filter: filter('factory/#'), qos: 1, owner: 'capture:1' });

    expect(transports.last.subscriptions.map((s) => s.options.qos)).toEqual([0, 1]);
    expect(manager.brokerFilters).toEqual(['#']);
  });
});

describe('the read policy decides first', () => {
  it('refuses a filter the policy denies, before asking the broker', async () => {
    const { manager, transports } = harness(
      createReadPolicy({ allow: [filter('#')], deny: [filter('factory/secrets/#')] }),
    );

    await expect(
      manager.acquire({ filter: filter('factory/secrets/#'), qos: 0, owner: 'capture:1' }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(transports.created).toHaveLength(0);
  });

  it('narrows a request onto the allowed sub-trees', async () => {
    const { manager } = harness(
      createReadPolicy({ allow: [filter('factory/#'), filter('plant/#')], deny: [] }),
    );

    const lease = await manager.acquire({ filter: filter('#'), qos: 0, owner: 'discovery' });

    expect(lease.effectiveFilters).toEqual(['factory/#', 'plant/#']);
    expect(manager.brokerFilters).toEqual(['factory/#', 'plant/#']);
  });

  it('reports the deny rules whose messages ingest must drop', async () => {
    const { manager } = harness(
      createReadPolicy({ allow: [filter('#')], deny: [filter('factory/+/secrets/#')] }),
    );

    const lease = await manager.acquire({
      filter: filter('factory/#'),
      qos: 0,
      owner: 'discovery',
    });

    expect(lease.filteredByDeny).toEqual(['factory/+/secrets/#']);
    expect(lease.active).toBe(true);
  });
});

describe('a broker that refuses', () => {
  it('records the refusal on the lease instead of throwing', async () => {
    const { manager, connection, transports, metrics } = harness();
    await connection.ensureConnected();
    transports.last.subscribeOutcomes.set('#', { granted: false, reasonCode: 0x87 });

    const lease = await manager.acquire({ filter: filter('#'), qos: 0, owner: 'discovery' });

    expect(lease.active).toBe(false);
    expect(lease.rejected).toEqual([{ filter: '#', reasonCode: 0x87 }]);
    expect(manager.brokerFilters).toEqual([]);
    expect(metrics.total('mqtt_intelligence.subscriptions.rejected')).toBe(1);
  });

  it('leaves other leases working', async () => {
    // A $ tree has to be allowed explicitly, so here it is the broker that refuses.
    const { manager, connection, transports } = harness(
      createReadPolicy({ allow: [filter('#'), filter('$SYS/#')], deny: [] }),
    );
    await connection.ensureConnected();
    transports.last.subscribeOutcomes.set('$SYS/#', { granted: false, reasonCode: 0x87 });

    const refused = await manager.acquire({
      filter: filter('$SYS/#'),
      qos: 0,
      owner: 'discovery',
    });
    const accepted = await manager.acquire({
      filter: filter('factory/#'),
      qos: 0,
      owner: 'discovery',
    });

    expect(refused.active).toBe(false);
    expect(accepted.active).toBe(true);
    expect(manager.brokerFilters).toEqual(['factory/#']);
  });

  it('does not ask again for a filter it already refused', async () => {
    const { manager, connection, transports } = harness(
      createReadPolicy({ allow: [filter('#'), filter('$SYS/#')], deny: [] }),
    );
    await connection.ensureConnected();
    transports.last.subscribeOutcomes.set('$SYS/#', { granted: false, reasonCode: 0x87 });
    await manager.acquire({ filter: filter('$SYS/#'), qos: 0, owner: 'discovery' });

    await manager.acquire({ filter: filter('$SYS/#'), qos: 0, owner: 'capture:1' });

    expect(transports.last.subscriptions).toHaveLength(0);
    expect(transports.last.subscribedFilters.filter((value) => value === '$SYS/#')).toHaveLength(0);
  });
});

describe('releasing', () => {
  it('unsubscribes a tree nobody needs any more', async () => {
    const { manager, transports } = harness();
    const lease = await manager.acquire({
      filter: filter('factory/#'),
      qos: 0,
      owner: 'capture:1',
    });

    await lease.release();

    expect(manager.brokerFilters).toEqual([]);
    expect(transports.last.unsubscribed).toEqual(['factory/#']);
  });

  it('keeps a tree another lease still needs', async () => {
    const { manager, transports } = harness();
    const first = await manager.acquire({ filter: filter('factory/#'), qos: 0, owner: 'a' });
    await manager.acquire({ filter: filter('factory/#'), qos: 0, owner: 'b' });

    await first.release();

    expect(manager.brokerFilters).toEqual(['factory/#']);
    expect(transports.last.unsubscribed).toEqual([]);
  });

  it('falls back to the narrower subscriptions a broad lease was covering', async () => {
    const { manager } = harness();
    await manager.acquire({ filter: filter('factory/#'), qos: 0, owner: 'capture:1' });
    const broad = await manager.acquire({ filter: filter('#'), qos: 0, owner: 'discovery' });

    await broad.release();

    expect(manager.brokerFilters).toEqual(['factory/#']);
  });

  it('is idempotent', async () => {
    const { manager, transports } = harness();
    const lease = await manager.acquire({ filter: filter('factory/#'), qos: 0, owner: 'a' });

    await lease.release();
    await lease.release();

    expect(transports.last.unsubscribed).toEqual(['factory/#']);
  });
});

describe('after a reconnection', () => {
  it('reinstates the desired set, because the broker has none of it', async () => {
    const { manager, connection, clock, transports } = harness();
    await manager.acquire({ filter: filter('factory/#'), qos: 1, owner: 'discovery' });
    const first = transports.last;

    first.dropConnection();
    await clock.advance(1000);

    expect(transports.created).toHaveLength(2);
    expect(transports.last.subscribedFilters).toEqual(['factory/#']);
    expect(manager.brokerFilters).toEqual(['factory/#']);
    expect(connection.status.reconnections).toBe(1);
  });

  it('asks again for a filter the previous connection refused', async () => {
    const { manager, clock, transports } = harness();
    await manager.acquire({ filter: filter('factory/#'), qos: 0, owner: 'discovery' });
    const first = transports.last;
    first.subscribeOutcomes.set('factory/#', { granted: false, reasonCode: 0x87 });

    first.dropConnection();
    await clock.advance(1000);

    // A restarted broker may have been reconfigured: the refusal is not held against it.
    expect(transports.last.subscribedFilters).toEqual(['factory/#']);
  });
});

describe('routing', () => {
  it('names the leases a topic belongs to', async () => {
    const { manager } = harness();
    const discovery = await manager.acquire({ filter: filter('#'), qos: 0, owner: 'discovery' });
    const capture = await manager.acquire({
      filter: filter('factory/line-01/#'),
      qos: 0,
      owner: 'capture:1',
    });

    expect(manager.matchingLeaseIds(parseTopicName('factory/line-01/robot'))).toEqual([
      discovery.id,
      capture.id,
    ]);
    expect(manager.matchingLeaseIds(parseTopicName('plant/a'))).toEqual([discovery.id]);
  });

  it('forgets a released lease', async () => {
    const { manager } = harness();
    const lease = await manager.acquire({ filter: filter('#'), qos: 0, owner: 'discovery' });

    await lease.release();

    expect(manager.matchingLeaseIds(parseTopicName('a/b'))).toEqual([]);
  });
});

describe('closing', () => {
  it('drops every lease and unsubscribes', async () => {
    const { manager, transports } = harness();
    await manager.acquire({ filter: filter('#'), qos: 0, owner: 'discovery' });

    await manager.close();

    expect(manager.brokerFilters).toEqual([]);
    expect(transports.last.unsubscribed).toEqual(['#']);
    await expect(
      manager.acquire({ filter: filter('#'), qos: 0, owner: 'late' }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});

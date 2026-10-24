/**
 * The subscription manager against a real broker.
 *
 * Two things cannot be settled with a fake: whether a broker delivers one message once per
 * matching subscription — which would inflate every count the catalog keeps — and whether a
 * restarted broker really comes back with none of our subscriptions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrokerConnectionOptions, InboundMessage } from '../../src/index.js';
import {
  BrokerConnection,
  createReadPolicy,
  MqttJsTransportFactory,
  parseBrokerId,
  parseTopicFilter,
  SubscriptionManager,
} from '../../src/index.js';
import { freeHostPort, startMosquitto, type RunningMosquitto } from './mosquitto.js';
import { publishMessages } from './publisher.js';

const BROKER = parseBrokerId('factory-fr');
const filter = parseTopicFilter;

function connectionFor(broker: RunningMosquitto): BrokerConnectionOptions {
  return {
    brokerId: BROKER,
    transport: {
      url: broker.url,
      protocolVersion: 5,
      clientId: `mqtt-observer-subs-${Math.random().toString(16).slice(2, 10)}`,
      keepaliveSeconds: 5,
      connectTimeoutMs: 5000,
    },
    reconnect: { initialDelayMs: 200, maxDelayMs: 2000 },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for a condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('overlapping leases', () => {
  let broker: RunningMosquitto;

  beforeAll(async () => {
    broker = await startMosquitto({ hostPort: await freeHostPort() });
  }, 180_000);

  afterAll(async () => {
    await broker.stop();
  });

  /**
   * The reason the manager keeps a minimal covering set at all.
   *
   * MQTT allows a server to deliver a message once per matching subscription, so two
   * overlapping subscriptions on one connection can double every count. Keeping one covering
   * filter removes the question entirely, and this test proves it does.
   */
  it('deliver a message exactly once', async () => {
    const messages: InboundMessage[] = [];
    const connection = new BrokerConnection(connectionFor(broker), {
      transportFactory: new MqttJsTransportFactory(),
      onMessage: (_brokerId, message) => messages.push(message),
    });
    const manager = new SubscriptionManager({
      connection,
      policy: createReadPolicy({ allow: [filter('#')], deny: [] }),
    });

    const discovery = await manager.acquire({ filter: filter('#'), qos: 0, owner: 'discovery' });
    const capture = await manager.acquire({
      filter: filter('factory/line-01/#'),
      qos: 0,
      owner: 'capture:1',
    });
    await publishMessages(broker.url, [
      { topic: 'factory/line-01/robot/status', payload: '{"ready":true}' },
    ]);
    await waitFor(() => messages.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await manager.close();
    await connection.close();

    expect(manager.brokerFilters).toEqual([]);
    expect(discovery.active).toBe(true);
    expect(capture.active).toBe(true);
    expect(messages.map((message) => message.topic)).toEqual(['factory/line-01/robot/status']);
  }, 60_000);

  it('stop delivering what the last interested lease released', async () => {
    const messages: InboundMessage[] = [];
    const connection = new BrokerConnection(connectionFor(broker), {
      transportFactory: new MqttJsTransportFactory(),
      onMessage: (_brokerId, message) => messages.push(message),
    });
    const manager = new SubscriptionManager({
      connection,
      policy: createReadPolicy({ allow: [filter('#')], deny: [] }),
    });
    const lease = await manager.acquire({ filter: filter('plant/#'), qos: 0, owner: 'capture:1' });

    await lease.release();
    await publishMessages(broker.url, [{ topic: 'plant/a/temperature', payload: '21' }]);
    await new Promise((resolve) => setTimeout(resolve, 750));
    await manager.close();
    await connection.close();

    expect(messages).toEqual([]);
  }, 60_000);
});

describe('a broker that restarts', () => {
  let broker: RunningMosquitto;

  beforeAll(async () => {
    broker = await startMosquitto({ hostPort: await freeHostPort() });
  }, 180_000);

  afterAll(async () => {
    await broker.stop();
  });

  it('gets the subscriptions back, because the desired set is kept here', async () => {
    const messages: InboundMessage[] = [];
    const connection = new BrokerConnection(connectionFor(broker), {
      transportFactory: new MqttJsTransportFactory(),
      onMessage: (_brokerId, message) => messages.push(message),
    });
    const manager = new SubscriptionManager({
      connection,
      policy: createReadPolicy({ allow: [filter('#')], deny: [] }),
    });
    await manager.acquire({ filter: filter('factory/#'), qos: 1, owner: 'discovery' });

    broker = await broker.restart();
    await waitFor(() => connection.status.reconnections > 0);
    await waitFor(() => manager.brokerFilters.length === 1);

    await publishMessages(broker.url, [{ topic: 'factory/after-restart', payload: '1' }]);
    await waitFor(() => messages.some((message) => message.topic === 'factory/after-restart'));
    await manager.close();
    await connection.close();

    expect(messages.map((message) => message.topic)).toContain('factory/after-restart');
  }, 120_000);
});

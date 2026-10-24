/**
 * Reconnection against a broker that actually goes away.
 *
 * The unit tests script a disconnect; this one restarts a container. It is the only way to
 * know that a real socket death produces the event the state machine waits for, and that the
 * engine comes back on its own.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrokerConnectionOptions, BrokerState } from '../../src/index.js';
import {
  BrokerConnection,
  MqttJsTransportFactory,
  parseBrokerId,
  parseTopicFilter,
} from '../../src/index.js';
import type { RunningMosquitto } from './mosquitto.js';
import { freeHostPort, startMosquitto } from './mosquitto.js';
import { publishMessages } from './publisher.js';

const BROKER = parseBrokerId('factory-fr');

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for a condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function optionsFor(broker: RunningMosquitto): BrokerConnectionOptions {
  return {
    brokerId: BROKER,
    transport: {
      url: broker.url,
      protocolVersion: 5,
      clientId: `mqtt-observer-reconnect-${Math.random().toString(16).slice(2, 10)}`,
      keepaliveSeconds: 5,
      connectTimeoutMs: 5000,
    },
    reconnect: { initialDelayMs: 200, maxDelayMs: 2000 },
  };
}

describe('a broker that restarts', () => {
  let broker: RunningMosquitto;

  beforeAll(async () => {
    // A restart reassigns a random mapping, so the broker is pinned to one host port.
    broker = await startMosquitto({ hostPort: await freeHostPort() });
  }, 180_000);

  afterAll(async () => {
    await broker.stop();
  });

  it('reconnects on its own, and says it was away', async () => {
    const states: BrokerState[] = [];
    const connection = new BrokerConnection(optionsFor(broker), {
      transportFactory: new MqttJsTransportFactory(),
    });
    connection.onStateChange((status) => states.push(status.state));
    await connection.ensureConnected();

    broker = await broker.restart();

    await waitFor(
      () => connection.status.state === 'backoff' || connection.status.reconnections > 0,
    );
    await waitFor(() => connection.status.state === 'connected');
    await connection.close();

    expect(states).toContain('backoff');
    expect(connection.status.reconnections).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('receives messages again after reconnecting, once resubscribed', async () => {
    const received: string[] = [];
    const connection = new BrokerConnection(optionsFor(broker), {
      transportFactory: new MqttJsTransportFactory(),
      onMessage: (_brokerId, message) => received.push(message.topic),
    });
    // Subscriptions are not reinstated by the connection itself: that is the subscription
    // manager's job, which listens to exactly this event.
    connection.onConnected(() => {
      void connection.subscribe(parseTopicFilter('factory/#'), { qos: 1 });
    });

    await connection.ensureConnected();
    await publishMessages(broker.url, [{ topic: 'factory/before', payload: '1' }]);
    await waitFor(() => received.includes('factory/before'));

    broker = await broker.restart();
    await waitFor(() => connection.status.reconnections > 0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await publishMessages(broker.url, [{ topic: 'factory/after', payload: '2' }]);
    await waitFor(() => received.includes('factory/after'));
    await connection.close();

    expect(received).toContain('factory/before');
    expect(received).toContain('factory/after');
  }, 120_000);
});

describe('a broker that is not there', () => {
  it('waits in backoff and stops when closed', async () => {
    const connection = new BrokerConnection(
      {
        brokerId: BROKER,
        transport: {
          // Port 1 is reserved and nothing listens on it.
          url: 'mqtt://127.0.0.1:1',
          protocolVersion: 5,
          clientId: 'mqtt-observer-unreachable',
          keepaliveSeconds: 5,
          connectTimeoutMs: 2000,
        },
        reconnect: { initialDelayMs: 200, maxDelayMs: 1000 },
      },
      { transportFactory: new MqttJsTransportFactory() },
    );

    await expect(connection.ensureConnected()).rejects.toMatchObject({
      code: 'BROKER_CONNECTION_FAILED',
    });
    expect(connection.status.state).toBe('backoff');

    await connection.close();
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(connection.status.state).toBe('closed');
  }, 60_000);
});

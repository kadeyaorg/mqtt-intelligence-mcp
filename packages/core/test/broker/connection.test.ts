/**
 * Every transition of the connection state machine, driven by a fake clock and a fake
 * transport: no sleeping, no broker, no flakiness.
 */
import { describe, expect, it } from 'vitest';
import type { BrokerConnectionOptions, BrokerState, TransportOptions } from '../../src/index.js';
import { BrokerConnection, BrokerError, parseBrokerId, parseTopicFilter } from '../../src/index.js';
import {
  FakeClock,
  FakeTransportFactory,
  InMemoryMetricsRecorder,
} from '../../src/testing/index.js';

const BROKER = parseBrokerId('factory-fr');

const transportOptions: TransportOptions = {
  url: 'mqtt://localhost:1883',
  protocolVersion: 5,
  clientId: 'mqtt-intel-test',
  keepaliveSeconds: 30,
  connectTimeoutMs: 10_000,
};

const options: BrokerConnectionOptions = {
  brokerId: BROKER,
  transport: transportOptions,
  reconnect: { initialDelayMs: 1000, maxDelayMs: 60_000 },
};

interface Harness {
  readonly connection: BrokerConnection;
  readonly clock: FakeClock;
  readonly transports: FakeTransportFactory;
  readonly metrics: InMemoryMetricsRecorder;
  readonly states: BrokerState[];
}

function harness(overrides: Partial<BrokerConnectionOptions> = {}, random = () => 1): Harness {
  const clock = new FakeClock();
  const transports = new FakeTransportFactory();
  const metrics = new InMemoryMetricsRecorder();
  const states: BrokerState[] = [];
  const connection = new BrokerConnection(
    { ...options, ...overrides },
    { transportFactory: transports, clock, metrics, random },
  );
  connection.onStateChange((status) => states.push(status.state));
  return { connection, clock, transports, metrics, states };
}

const networkFailure = { type: 'fail', error: new Error('ECONNREFUSED') } as const;
const authFailure = {
  type: 'fail',
  error: new BrokerError('BROKER_AUTH_FAILED', 'Broker refused the credentials'),
} as const;

describe('connecting', () => {
  it('goes from idle to connected, and announces it', async () => {
    const { connection, clock, transports, states } = harness();
    let announced = 0;
    connection.onConnected(() => {
      announced += 1;
    });

    expect(connection.status.state).toBe('idle');
    await connection.ensureConnected();

    expect(states).toEqual(['connecting', 'connected']);
    expect(connection.status).toMatchObject({
      brokerId: BROKER,
      state: 'connected',
      attempts: 0,
      reconnections: 0,
      connectedSince: clock.now(),
    });
    expect(transports.created).toHaveLength(1);
    expect(announced).toBe(1);
  });

  it('does not open a second connection when one is already in flight', async () => {
    const { connection, transports } = harness();

    await Promise.all([connection.ensureConnected(), connection.ensureConnected()]);

    expect(transports.created).toHaveLength(1);
  });

  it('records the attempt duration and the live connection', async () => {
    const { connection, metrics } = harness();

    await connection.ensureConnected();

    expect(
      metrics.recorded('mqtt_intelligence.broker.connect.duration', {
        broker: BROKER,
        outcome: 'success',
      }),
    ).toHaveLength(1);
    expect(metrics.total('mqtt_intelligence.broker.connections')).toBe(1);
  });

  it('keeps the capabilities the broker announced', async () => {
    const { connection, transports } = harness();
    transports.connectBehaviour = {
      type: 'success',
      result: { sessionPresent: false, capabilities: { maximumQoS: 1, retainAvailable: false } },
    };

    await connection.ensureConnected();

    expect(connection.status.capabilities).toEqual({ maximumQoS: 1, retainAvailable: false });
  });
});

describe('credentials refused', () => {
  it('fails without retrying, because brokers lock accounts', async () => {
    const { connection, clock, transports, states } = harness();
    transports.connectBehaviour = authFailure;

    await expect(connection.ensureConnected()).rejects.toMatchObject({
      code: 'BROKER_AUTH_FAILED',
    });
    await clock.advance(10 * 60 * 1000);

    expect(states).toEqual(['connecting', 'failed']);
    expect(transports.created).toHaveLength(1);
    expect(clock.pendingTimerCount).toBe(0);
    expect(connection.status.lastFailure?.code).toBe('BROKER_AUTH_FAILED');
  });

  it('answers immediately while it stays failed', async () => {
    const { connection, transports } = harness();
    transports.connectBehaviour = authFailure;
    await expect(connection.ensureConnected()).rejects.toThrow();

    await expect(connection.ensureConnected()).rejects.toMatchObject({
      code: 'BROKER_AUTH_FAILED',
      retryable: false,
    });
    expect(transports.created).toHaveLength(1);
  });

  it('attempts again only when asked explicitly', async () => {
    const { connection, transports } = harness();
    transports.connectBehaviour = authFailure;
    await expect(connection.ensureConnected()).rejects.toThrow();

    transports.connectBehaviour = { type: 'success' };
    await connection.retry();

    expect(connection.status.state).toBe('connected');
    expect(transports.created).toHaveLength(2);
  });
});

describe('network failures', () => {
  it('waits in backoff and attempts again', async () => {
    const { connection, clock, transports, states } = harness();
    transports.connectBehaviour = networkFailure;

    await expect(connection.ensureConnected()).rejects.toMatchObject({
      code: 'BROKER_CONNECTION_FAILED',
    });
    expect(connection.status.state).toBe('backoff');
    expect(connection.status.nextAttemptAt).toBe(clock.now() + 1000);

    transports.connectBehaviour = { type: 'success' };
    await clock.advance(1000);

    expect(states).toEqual(['connecting', 'backoff', 'connecting', 'connected']);
    expect(connection.status.attempts).toBe(0);
  });

  it('grows the delay exponentially and caps it', async () => {
    const { connection, clock, transports } = harness({
      reconnect: { initialDelayMs: 1000, maxDelayMs: 4000 },
    });
    transports.connectBehaviour = networkFailure;
    const delays: number[] = [];

    await expect(connection.ensureConnected()).rejects.toThrow();
    for (let round = 0; round < 4; round += 1) {
      delays.push((connection.status.nextAttemptAt ?? 0) - clock.now());
      await clock.advance(delays.at(-1) ?? 0);
    }

    expect(delays).toEqual([1000, 2000, 4000, 4000]);
  });

  it('spreads attempts with jitter, so a fleet does not return in lockstep', async () => {
    const { connection, clock, transports } = harness({}, () => 0.25);
    transports.connectBehaviour = networkFailure;

    await expect(connection.ensureConnected()).rejects.toThrow();

    expect((connection.status.nextAttemptAt ?? 0) - clock.now()).toBe(250);
  });

  it('tells a caller when the next attempt is due instead of blocking it', async () => {
    const { connection, clock, transports } = harness();
    transports.connectBehaviour = networkFailure;
    await expect(connection.ensureConnected()).rejects.toThrow();

    const error = await connection.ensureConnected().catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      code: 'BROKER_UNAVAILABLE',
      retryable: true,
      details: { nextAttemptAt: clock.now() + 1000 },
    });
  });

  it('treats a connection that never answers as a timeout', async () => {
    const { connection, clock, transports, metrics } = harness();
    transports.connectBehaviour = { type: 'hang' };

    const pending = connection.ensureConnected().catch((reason: unknown) => reason);
    await clock.advance(10_000);

    await expect(pending).resolves.toMatchObject({ code: 'BROKER_CONNECTION_FAILED' });
    expect(connection.status.lastFailure?.code).toBe('TIMEOUT');
    expect(connection.status.state).toBe('backoff');
    expect(
      metrics.recorded('mqtt_intelligence.broker.connect.duration', { outcome: 'failure' }),
    ).toHaveLength(1);
  });
});

describe('losing a live connection', () => {
  it('goes back to backoff and reconnects', async () => {
    const { connection, clock, transports, metrics, states } = harness();
    await connection.ensureConnected();
    states.length = 0;

    transports.last.dropConnection();
    expect(connection.status.state).toBe('backoff');

    await clock.advance(1000);

    expect(states).toEqual(['backoff', 'connecting', 'connected']);
    expect(connection.status.reconnections).toBe(1);
    expect(metrics.total('mqtt_intelligence.broker.reconnections')).toBe(1);
    expect(metrics.total('mqtt_intelligence.broker.connections')).toBe(1);
  });

  it('announces every new connection, so subscriptions can be reinstated', async () => {
    const { connection, clock, transports } = harness();
    let announced = 0;
    connection.onConnected(() => {
      announced += 1;
    });

    await connection.ensureConnected();
    transports.last.dropConnection();
    await clock.advance(1000);

    expect(announced).toBe(2);
  });

  it('ignores a disconnect reported by a transport it already replaced', async () => {
    const { connection, clock, transports } = harness();
    await connection.ensureConnected();
    const first = transports.last;
    first.dropConnection();
    await clock.advance(1000);

    first.dropConnection();

    expect(connection.status.state).toBe('connected');
  });
});

describe('messages', () => {
  it('forwards messages from the live connection', async () => {
    const clock = new FakeClock();
    const transports = new FakeTransportFactory();
    const received: string[] = [];
    const connection = new BrokerConnection(options, {
      transportFactory: transports,
      clock,
      onMessage: (brokerId, message) => received.push(`${brokerId}:${message.topic}`),
    });
    await connection.ensureConnected();

    transports.last.deliver({ topic: 'factory/line-01/robot/status' });

    expect(received).toEqual(['factory-fr:factory/line-01/robot/status']);
  });

  it('ignores a message from a transport that has been closed', async () => {
    const clock = new FakeClock();
    const transports = new FakeTransportFactory();
    const received: string[] = [];
    const connection = new BrokerConnection(options, {
      transportFactory: transports,
      clock,
      onMessage: (_brokerId, message) => received.push(message.topic),
    });
    await connection.ensureConnected();
    const transport = transports.last;
    await connection.close();

    transport.deliver({ topic: 'late/message' });

    expect(received).toEqual([]);
  });
});

describe('subscriptions', () => {
  it('connects on demand before subscribing', async () => {
    const { connection, transports } = harness();

    const outcome = await connection.subscribe(parseTopicFilter('factory/#'), { qos: 0 });

    expect(outcome).toMatchObject({ filter: 'factory/#', granted: true });
    expect(transports.last.subscribedFilters).toEqual(['factory/#']);
  });

  it('reports a refusal as an outcome rather than an exception', async () => {
    const { connection, transports } = harness();
    await connection.ensureConnected();
    transports.last.subscribeOutcomes.set('#', { granted: false, reasonCode: 0x87 });

    const outcome = await connection.subscribe(parseTopicFilter('#'), { qos: 0 });

    expect(outcome).toMatchObject({ granted: false, reasonCode: 0x87 });
    expect(transports.last.subscribedFilters).toEqual([]);
  });

  it('unsubscribes through the live transport', async () => {
    const { connection, transports } = harness();
    await connection.subscribe(parseTopicFilter('factory/#'), { qos: 0 });

    await connection.unsubscribe(parseTopicFilter('factory/#'));

    expect(transports.last.unsubscribed).toEqual(['factory/#']);
    expect(transports.last.subscribedFilters).toEqual([]);
  });
});

describe('shutting down', () => {
  it('closes a live connection', async () => {
    const { connection, transports, states } = harness();
    await connection.ensureConnected();
    states.length = 0;

    await connection.close();

    expect(states).toEqual(['closing', 'closed']);
    expect(transports.last.closeCount).toBe(1);
    expect(connection.status.connectedSince).toBeUndefined();
  });

  it('cancels a pending backoff instead of waking up later', async () => {
    const { connection, clock, transports } = harness();
    transports.connectBehaviour = networkFailure;
    await expect(connection.ensureConnected()).rejects.toThrow();

    await connection.close();
    await clock.advance(60_000);

    expect(clock.pendingTimerCount).toBe(0);
    expect(transports.created).toHaveLength(1);
  });

  it('discards a connection that completes after close was called', async () => {
    const { connection, clock, transports } = harness();
    transports.connectBehaviour = { type: 'hang' };
    const pending = connection.ensureConnected().catch(() => undefined);
    await connection.close();

    await clock.advance(10_000);
    await pending;

    expect(connection.status.state).toBe('closed');
    expect(transports.last.connected).toBe(false);
  });

  it('refuses to work once closed', async () => {
    const { connection } = harness();
    await connection.close();

    await expect(connection.ensureConnected()).rejects.toMatchObject({
      code: 'BROKER_UNAVAILABLE',
    });
    await expect(connection.retry()).rejects.toMatchObject({ code: 'BROKER_UNAVAILABLE' });
  });

  it('is idempotent', async () => {
    const { connection, transports } = harness();
    await connection.ensureConnected();

    await connection.close();
    await connection.close();

    expect(transports.last.closeCount).toBe(1);
  });
});

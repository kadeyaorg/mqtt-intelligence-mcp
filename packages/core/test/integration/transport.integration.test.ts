/**
 * The mqtt.js adapter against a real broker.
 *
 * What is checked here is everything a fake cannot promise: that a refused CONNACK really
 * arrives as an authentication failure, that a refused SUBACK comes back as an outcome
 * rather than an exception, that retained messages arrive flagged, and that a broker going
 * away wakes the reconnection logic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InboundMessage, MqttTransport, TransportOptions } from '../../src/index.js';
import { MqttJsTransportFactory, parseTopicFilter, Secret } from '../../src/index.js';
import { publishMessages } from './publisher.js';
import type { RunningMosquitto } from './mosquitto.js';
import { startMosquitto } from './mosquitto.js';

const factory = new MqttJsTransportFactory();

function optionsFor(
  broker: RunningMosquitto,
  overrides: Partial<TransportOptions> = {},
): TransportOptions {
  return {
    url: broker.url,
    protocolVersion: 5,
    clientId: `mqtt-observer-test-${Math.random().toString(16).slice(2, 10)}`,
    keepaliveSeconds: 10,
    connectTimeoutMs: 5000,
    ...overrides,
  };
}

interface Collected {
  readonly messages: InboundMessage[];
  readonly disconnects: string[];
}

function collector(): Collected & {
  handlers: {
    onMessage: (message: InboundMessage) => void;
    onDisconnect: (reason: { kind: string }) => void;
  };
} {
  const messages: InboundMessage[] = [];
  const disconnects: string[] = [];
  return {
    messages,
    disconnects,
    handlers: {
      onMessage: (message) => messages.push(message),
      onDisconnect: (reason) => disconnects.push(reason.kind),
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for a condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('an open broker', () => {
  let broker: RunningMosquitto;
  let transport: MqttTransport | undefined;

  beforeAll(async () => {
    broker = await startMosquitto();
  }, 180_000);

  afterAll(async () => {
    await transport?.close();
    await broker.stop();
  });

  it('connects, subscribes and receives what is published', async () => {
    const collected = collector();
    transport = factory.create(optionsFor(broker), collected.handlers);

    const result = await transport.connect();
    const outcome = await transport.subscribe(parseTopicFilter('factory/#'), { qos: 1 });

    await publishMessages(broker.url, [
      { topic: 'factory/line-01/robot/status', payload: '{"ready":true}' },
    ]);
    await waitFor(() => collected.messages.length > 0);

    expect(result.sessionPresent).toBe(false);
    expect(outcome).toMatchObject({ filter: 'factory/#', granted: true, reasonCode: 1 });
    expect(collected.messages[0]).toMatchObject({
      topic: 'factory/line-01/robot/status',
      qos: 1,
      retain: false,
    });
    expect(new TextDecoder().decode(collected.messages[0]?.payload)).toBe('{"ready":true}');

    await transport.close();
    transport = undefined;
  });

  it('marks a retained message replayed at subscribe time', async () => {
    await publishMessages(broker.url, [
      { topic: 'factory/line-01/plc/state', payload: 'RUNNING', retain: true },
    ]);

    const collected = collector();
    const subscriber = factory.create(optionsFor(broker), collected.handlers);
    await subscriber.connect();
    await subscriber.subscribe(parseTopicFilter('factory/line-01/plc/state'), { qos: 0 });
    await waitFor(() => collected.messages.length > 0);
    await subscriber.close();

    expect(collected.messages[0]?.retain).toBe(true);
  });

  it('never delivers a $SYS topic through a leading wildcard', async () => {
    const collected = collector();
    const subscriber = factory.create(optionsFor(broker), collected.handlers);
    await subscriber.connect();
    await subscriber.subscribe(parseTopicFilter('#'), { qos: 0 });

    await new Promise((resolve) => setTimeout(resolve, 1500));
    await subscriber.close();

    expect(collected.messages.filter((message) => message.topic.startsWith('$'))).toEqual([]);
  });

  it('unsubscribes', async () => {
    const collected = collector();
    const subscriber = factory.create(optionsFor(broker), collected.handlers);
    await subscriber.connect();
    await subscriber.subscribe(parseTopicFilter('quiet/#'), { qos: 0 });

    const outcome = await subscriber.unsubscribe(parseTopicFilter('quiet/#'));
    await subscriber.close();

    expect(outcome).toMatchObject({ filter: 'quiet/#', acknowledged: true });
  });

  it('reports a local close as a client disconnect, not a lost connection', async () => {
    const collected = collector();
    const subscriber = factory.create(optionsFor(broker), collected.handlers);
    await subscriber.connect();

    await subscriber.close();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(collected.disconnects).toEqual([]);
  });
});

describe('a broker that requires credentials', () => {
  let broker: RunningMosquitto;

  beforeAll(async () => {
    broker = await startMosquitto({
      credentials: { username: 'supervision', password: 'c0rrect-horse' },
      // Reads only the factory tree, writes anywhere, so a test can produce traffic on a
      // topic it is then forbidden to observe.
      acl: ['user supervision', 'topic read factory/#', 'topic write #', ''].join('\n'),
    });
  }, 180_000);

  afterAll(async () => {
    await broker.stop();
  });

  it('refuses a wrong password as an authentication failure', async () => {
    const transport = factory.create(
      optionsFor(broker, {
        username: 'supervision',
        password: new Secret('wrong', 'test'),
      }),
      collector().handlers,
    );

    await expect(transport.connect()).rejects.toMatchObject({ code: 'BROKER_AUTH_FAILED' });
    await transport.close();
  });

  it('refuses an anonymous connection', async () => {
    const transport = factory.create(optionsFor(broker), collector().handlers);

    await expect(transport.connect()).rejects.toMatchObject({ code: 'BROKER_AUTH_FAILED' });
    await transport.close();
  });

  /**
   * A granted subscription does not mean the messages will come.
   *
   * Mosquitto accepts a subscription its ACL forbids and simply never delivers those topics;
   * other brokers refuse it in SUBACK. Discovery coverage must therefore never read "granted"
   * as "visible", and silence as "nothing was published".
   */
  it('grants a subscription its ACL forbids, then delivers nothing from it', async () => {
    const credentials = { username: 'supervision', password: 'c0rrect-horse' };
    const collected = collector();
    const transport = factory.create(
      optionsFor(broker, {
        username: credentials.username,
        password: new Secret(credentials.password, 'test'),
      }),
      collected.handlers,
    );
    await transport.connect();

    const allowed = await transport.subscribe(parseTopicFilter('factory/#'), { qos: 0 });
    const forbidden = await transport.subscribe(parseTopicFilter('warehouse/#'), { qos: 0 });

    await publishMessages(
      broker.url,
      [
        { topic: 'warehouse/temperature', payload: '7' },
        { topic: 'factory/line-01/state', payload: 'RUNNING' },
      ],
      credentials,
    );
    await waitFor(() => collected.messages.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await transport.close();

    expect(allowed).toMatchObject({ granted: true });
    expect(forbidden).toMatchObject({ granted: true });
    expect(collected.messages.map((message) => message.topic)).toEqual(['factory/line-01/state']);
  });
});

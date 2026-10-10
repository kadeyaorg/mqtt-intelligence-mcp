/**
 * The engine facade.
 *
 * What is checked here is the contract an adapter depends on: which broker an omitted id
 * means, what an answer carries besides its facts, and that a wait can be cancelled.
 */
import { describe, expect, it } from 'vitest';
import type { Engine, EngineConfig } from '../src/index.js';
import {
  createEngine,
  parseBrokerId,
  parseConfigDocument,
  parseTopicFilter,
  parseTopicName,
  resolveConfig,
} from '../src/index.js';
import { FakeClock, FakeTransportFactory } from '../src/testing/index.js';

const FACTORY = parseBrokerId('factory-fr');
const STAGING = parseBrokerId('staging');

async function configOf(
  brokers: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Promise<EngineConfig> {
  return resolveConfig(parseConfigDocument({ version: 1, brokers, ...overrides }), { env: {} });
}

/** Lets pending promises reach their next timer before the clock moves. */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface Harness {
  readonly engine: Engine;
  readonly clock: FakeClock;
  readonly transports: FakeTransportFactory;
}

async function harness(
  brokers: Record<string, unknown> = { 'factory-fr': { url: 'mqtt://localhost:1883' } },
  overrides: Record<string, unknown> = {},
): Promise<Harness> {
  const clock = new FakeClock();
  const transports = new FakeTransportFactory();
  const engine = createEngine(await configOf(brokers, overrides), {
    clock,
    transportFactory: transports,
  });
  return { engine, clock, transports };
}

describe('starting', () => {
  it('connects and starts observing the brokers configured to start', async () => {
    const { engine, transports } = await harness();

    await engine.start();
    const [broker] = await engine.listBrokers();

    expect(broker?.status.state).toBe('connected');
    expect(broker?.discovery.filters).toEqual(['#']);
    expect(transports.last.subscribedFilters).toEqual(['#']);
    await engine.close();
  });

  it('leaves a lazy broker alone until it is used', async () => {
    const { engine, transports } = await harness({
      'factory-fr': { url: 'mqtt://localhost:1883', connect: 'lazy' },
    });

    await engine.start();
    expect(transports.created).toHaveLength(0);

    await engine.discover();
    expect(transports.created).toHaveLength(1);
    await engine.close();
  });

  it('keeps working when one broker cannot connect', async () => {
    const { engine, transports } = await harness({
      'factory-fr': { url: 'mqtt://localhost:1883' },
      staging: { url: 'mqtt://localhost:1884' },
    });
    transports.connectBehaviour = { type: 'fail', error: new Error('ECONNREFUSED') };

    await engine.start();
    const reports = await engine.listBrokers();

    expect(reports).toHaveLength(2);
    expect(reports.every((report) => report.status.state === 'backoff')).toBe(true);
    await engine.close();
  });
});

describe('choosing a broker', () => {
  it('uses the only configured broker when none is named', async () => {
    const { engine } = await harness();
    await engine.start();

    const answer = await engine.discover();

    expect(answer.facts.brokerId).toBe(FACTORY);
    await engine.close();
  });

  it('refuses to guess between several, and names them', async () => {
    const { engine } = await harness({
      'factory-fr': { url: 'mqtt://localhost:1883' },
      staging: { url: 'mqtt://localhost:1884' },
    });

    await expect(engine.discover()).rejects.toMatchObject({ code: 'BROKER_AMBIGUOUS' });
    await engine.close();
  });

  it('reports an unknown broker as such', async () => {
    const { engine } = await harness();

    await expect(engine.discover({ brokerId: STAGING })).rejects.toMatchObject({
      code: 'BROKER_NOT_FOUND',
    });
    await engine.close();
  });
});

describe('answers carry what they cannot tell', () => {
  it('warns that a short window is not evidence of absence', async () => {
    const { engine } = await harness();
    await engine.start();

    const answer = await engine.discover();

    expect(answer.limitations.map((limitation) => limitation.code)).toContain(
      'SHORT_OBSERVATION_WINDOW',
    );
    expect(answer.coverage.filters).toEqual(['#']);
    await engine.close();
  });

  it('reports a disconnection as a gap', async () => {
    const { engine, clock, transports } = await harness();
    await engine.start();
    transports.last.dropConnection();
    await clock.advance(100);

    const answer = await engine.topicTree();

    expect(answer.limitations.map((limitation) => limitation.code)).toContain(
      'DISCONNECTED_DURING_WINDOW',
    );
    await engine.close();
  });

  it('warns that QoS is the delivered one when describing a topic', async () => {
    const { engine, clock, transports } = await harness();
    await engine.start();
    transports.last.deliver({ topic: 'factory/robot', payload: new TextEncoder().encode('1') });
    await clock.advance(100);

    const answer = await engine.describeTopic({ topic: parseTopicName('factory/robot') });

    expect(answer.facts.messageCount).toBe(1);
    expect(answer.limitations.map((limitation) => limitation.code)).toContain('DELIVERED_QOS_ONLY');
    await engine.close();
  });

  it('says a topic was never observed rather than that it does not exist', async () => {
    const { engine } = await harness();
    await engine.start();

    const failure = await engine
      .describeTopic({ topic: parseTopicName('never/published') })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'TOPIC_NOT_OBSERVED' });
    expect((failure as Error).message).toContain('It may still exist');
    await engine.close();
  });
});

describe('reading what was observed', () => {
  async function observed(): Promise<Harness> {
    const started = await harness();
    await started.engine.start();
    const transport = started.transports.last;
    transport.deliver({
      topic: 'factory/line-01/robot/status',
      payload: new TextEncoder().encode('{"ready":true,"password":"hunter2"}'),
      qos: 1,
    });
    transport.deliver({
      topic: 'factory/line-01/plc/state',
      payload: new TextEncoder().encode('RUNNING'),
      retain: true,
    });
    await started.clock.advance(100);
    return started;
  }

  it('builds a tree of what it saw', async () => {
    const { engine } = await observed();

    const answer = await engine.topicTree({ depth: 3 });

    expect(answer.facts.topicCount).toBe(2);
    expect(answer.facts.children[0]?.segment).toBe('factory');
    await engine.close();
  });

  it('searches, sorts and reports rates as observations', async () => {
    const { engine } = await observed();

    const answer = await engine.searchTopics({ filter: parseTopicFilter('factory/#') });

    expect(answer.facts.topics).toHaveLength(2);
    expect(answer.facts.topics[0]?.messagesPerSecond).toBeGreaterThanOrEqual(0);
    await engine.close();
  });

  it('describes a topic, separating facts from computed observations', async () => {
    const { engine } = await observed();

    const answer = await engine.describeTopic({
      topic: parseTopicName('factory/line-01/robot/status'),
    });

    expect(answer.facts.deliveredQosCounts).toEqual({ qos0: 0, qos1: 1, qos2: 0 });
    expect(answer.facts.payloadKinds).toEqual({ json: 1 });
    expect(answer.observations?.rateMethod).toContain('decayed');
    await engine.close();
  });

  it('redacts a secret inside a payload it shows', async () => {
    const { engine } = await observed();

    const answer = await engine.recentMessages({
      topic: parseTopicName('factory/line-01/robot/status'),
    });

    expect(JSON.stringify(answer.facts.messages)).not.toContain('hunter2');
    expect(JSON.stringify(answer.facts.messages)).toContain('[REDACTED]');
    await engine.close();
  });

  it('marks a retained replay for what it is', async () => {
    const { engine } = await observed();

    const answer = await engine.recentMessages({
      topic: parseTopicName('factory/line-01/plc/state'),
    });

    expect(answer.facts.messages[0]?.retainedReplay).toBe(true);
    expect(answer.limitations.map((limitation) => limitation.code)).toContain(
      'RETAINED_REPLAY_TIME_UNKNOWN',
    );
    await engine.close();
  });
});

describe('waiting while discovering', () => {
  it('reports progress and how long it waited', async () => {
    const { engine, clock } = await harness();
    await engine.start();
    const progress: number[] = [];

    const pending = engine.discover(
      { waitSeconds: 1 },
      { onProgress: (update) => progress.push(update.ratio ?? 0) },
    );
    await settle();
    await clock.advance(1000);
    const answer = await pending;

    expect(answer.facts.waitedMs).toBeGreaterThanOrEqual(1000);
    expect(progress.at(-1)).toBe(1);
    await engine.close();
  });

  it('counts the topics discovered while it waited', async () => {
    const { engine, clock, transports } = await harness();
    await engine.start();

    const pending = engine.discover({ waitSeconds: 1 });
    await settle();
    transports.last.deliver({ topic: 'factory/new-topic' });
    await clock.advance(1000);
    const answer = await pending;

    expect(answer.facts.topicsDiscoveredWhileWaiting).toBe(1);
    await engine.close();
  });

  it('stops when the caller cancels', async () => {
    const { engine, clock } = await harness();
    await engine.start();
    const controller = new AbortController();

    const pending = engine.discover({ waitSeconds: 30 }, { signal: controller.signal });
    await settle();
    await clock.advance(250);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await engine.close();
  });

  it('never waits longer than the configured ceiling', async () => {
    const { engine, clock } = await harness(
      { 'factory-fr': { url: 'mqtt://localhost:1883' } },
      { mcp: { discoverMaxWaitSeconds: 1 } },
    );
    await engine.start();

    const pending = engine.discover({ waitSeconds: 300 });
    await settle();
    await clock.advance(1000);
    const answer = await pending;

    expect(answer.facts.waitedMs).toBeLessThan(2000);
    await engine.close();
  });
});

describe('closing', () => {
  it('stops everything and refuses further work', async () => {
    const { engine, transports } = await harness();
    await engine.start();

    await engine.close();

    expect(transports.last.closeCount).toBeGreaterThanOrEqual(1);
    await expect(engine.discover()).rejects.toMatchObject({ code: 'BROKER_UNAVAILABLE' });
  });
});

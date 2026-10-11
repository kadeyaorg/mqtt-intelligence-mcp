/**
 * The engine, end to end, against a real broker.
 *
 * This is the first test that answers the question the project exists for: point it at a
 * broker, let it watch, and ask what is there. Everything below the surface — subscriptions,
 * ingestion, bounds, policy, payload views — is exercised by doing exactly what an agent
 * will do.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/index.js';
import {
  createEngine,
  parseBrokerId,
  parseConfigDocument,
  parseTopicFilter,
  parseTopicName,
  resolveConfig,
} from '../../src/index.js';
import type { RunningMosquitto } from './mosquitto.js';
import { startMosquitto } from './mosquitto.js';
import { publishMessages } from './publisher.js';

const BROKER = parseBrokerId('factory-fr');

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for a condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function engineFor(
  broker: RunningMosquitto,
  overrides: Record<string, unknown> = {},
): Promise<Engine> {
  const config = await resolveConfig(
    parseConfigDocument({
      version: 1,
      brokers: { 'factory-fr': { url: broker.url, ...overrides } },
      limits: { flushIntervalMs: 50 },
    }),
    { env: {} },
  );
  return createEngine(config);
}

describe('an engine pointed at a broker', () => {
  let broker: RunningMosquitto;
  let engine: Engine;

  beforeAll(async () => {
    broker = await startMosquitto();

    // Retained BEFORE anyone subscribes, so that its delivery really is a replay. Published
    // after, it would be an ordinary live message that happens to carry the retain flag, and
    // the two must not be confused: see retained.integration.test.ts.
    await publishMessages(broker.url, [
      { topic: 'factory/line-01/plc/state', payload: 'RUNNING', retain: true },
    ]);

    engine = await engineFor(broker);
    await engine.start();

    await publishMessages(broker.url, [
      { topic: 'factory/line-01/robot/status', payload: '{"ready":true,"errorCode":0}' },
      { topic: 'factory/line-01/robot/status', payload: '{"ready":false,"errorCode":42}' },
      { topic: 'factory/line-01/robot/position', payload: '{"x":12.4,"y":8.1}' },
      { topic: 'factory/line-02/washer/status', payload: 'IDLE' },
      { topic: 'factory/line-01/hmi/alarm', payload: 'ROBOT_NOT_READY' },
      { topic: 'telemetry/temperature', payload: '21.5' },
      { topic: 'telemetry/binary', payload: '\u0000\u0001\u0002 binary' },
    ]);

    await waitFor(async () => (await engine.discover()).facts.topicCount >= 7);
  }, 180_000);

  afterAll(async () => {
    await engine.close();
    await broker.stop();
  });

  it('answers "what topics exist on this broker?"', async () => {
    const answer = await engine.discover();

    expect(answer.facts.brokerId).toBe(BROKER);
    expect(answer.facts.topicCount).toBeGreaterThanOrEqual(7);
    expect(answer.facts.topLevels.map((level) => level.segment).sort()).toEqual([
      'factory',
      'telemetry',
    ]);
    // And it says what it cannot know.
    expect(answer.limitations.map((limitation) => limitation.code)).toContain(
      'SHORT_OBSERVATION_WINDOW',
    );
  });

  it('answers "explain the architecture" with a tree', async () => {
    const answer = await engine.topicTree({ depth: 3 });
    const factory = answer.facts.children.find((child) => child.segment === 'factory');

    expect(factory?.topicCount).toBe(5);
    expect(factory?.children.map((child) => child.segment).sort()).toEqual(['line-01', 'line-02']);
  });

  it('answers "find all topics related to the robot"', async () => {
    const answer = await engine.searchTopics({ text: 'robot' });

    expect(answer.facts.topics.map((topic) => topic.topic).sort()).toEqual([
      'factory/line-01/robot/position',
      'factory/line-01/robot/status',
    ]);
  });

  it('answers "describe this topic", separating facts from observations', async () => {
    const answer = await engine.describeTopic({
      topic: parseTopicName('factory/line-01/robot/status'),
    });

    expect(answer.facts.messageCount).toBe(2);
    expect(answer.facts.payloadKinds.json).toBeGreaterThanOrEqual(1);
    expect(answer.facts.lastMessage?.payload.kind).toBe('json');
    expect(answer.observations?.messagesPerSecond).toBeGreaterThan(0);
    expect(answer.observations?.rateMethod).toContain('live messages only');
  });

  it('shows the last payload, parsed and bounded', async () => {
    const answer = await engine.recentMessages({
      topic: parseTopicName('factory/line-01/robot/status'),
      limit: 5,
    });
    const last = answer.facts.messages[0];

    expect(last?.payload.kind).toBe('json');
    if (last?.payload.kind === 'json') {
      expect(last.payload.value).toEqual({ ready: false, errorCode: 42 });
    }
    expect(answer.limitations.map((limitation) => limitation.code)).toContain('SAMPLED');
  });

  it('classifies what is not JSON without pretending otherwise', async () => {
    const numeric = await engine.describeTopic({ topic: parseTopicName('telemetry/temperature') });
    const binary = await engine.describeTopic({ topic: parseTopicName('telemetry/binary') });

    expect(numeric.facts.lastMessage?.payload.kind).toBe('number');
    expect(binary.facts.lastMessage?.payload.kind).toBe('binary');
    if (binary.facts.lastMessage?.payload.kind === 'binary') {
      // A hash and a preview, never the bytes.
      expect(binary.facts.lastMessage.payload.sha256).toHaveLength(64);
    }
  });

  it('marks the retained message the broker replayed at subscribe time', async () => {
    const answer = await engine.describeTopic({
      topic: parseTopicName('factory/line-01/plc/state'),
    });

    expect(answer.facts.retainedReplayCount).toBeGreaterThanOrEqual(1);
    expect(answer.facts.retainedState).toBe('present');
    expect(answer.limitations.map((limitation) => limitation.code)).toContain(
      'RETAINED_REPLAY_TIME_UNKNOWN',
    );
  });

  it('reports the broker, its connection and what discovery covers', async () => {
    const [report] = await engine.listBrokers();

    expect(report?.brokerId).toBe(BROKER);
    expect(report?.status.state).toBe('connected');
    expect(report?.tls.enabled).toBe(false);
    expect(report?.discovery.filters).toEqual(['#']);
    expect(report?.discovery.observedMs).toBeGreaterThan(0);
  });

  it('never observed $SYS, because "#" cannot reach it', async () => {
    const answer = await engine.searchTopics({ text: '$SYS' });

    expect(answer.facts.topics).toEqual([]);
  });
});

describe('an engine with a restrictive read policy', () => {
  let broker: RunningMosquitto;
  let engine: Engine;

  beforeAll(async () => {
    broker = await startMosquitto();
    engine = await engineFor(broker, {
      security: { read: { allow: ['factory/#'], deny: ['factory/+/secrets/#'] } },
    });
    await engine.start();

    await publishMessages(broker.url, [
      { topic: 'factory/line-01/robot/status', payload: '{"ready":true}' },
      { topic: 'factory/line-01/secrets/token', payload: 'hunter2' },
      { topic: 'warehouse/temperature', payload: '7' },
    ]);
    await waitFor(async () => (await engine.discover()).facts.topicCount >= 1);
  }, 180_000);

  afterAll(async () => {
    await engine.close();
    await broker.stop();
  });

  it('subscribes only what it is allowed to read', async () => {
    const [report] = await engine.listBrokers();

    // The policy narrowed the default "#" onto the allowed subtree.
    expect(report?.discovery.filters).toEqual(['factory/#']);
  });

  it('never shows a denied topic, nor its payload', async () => {
    const answer = await engine.searchTopics({ filter: parseTopicFilter('#') });
    const topics = answer.facts.topics.map((topic) => topic.topic);

    expect(topics).toContain('factory/line-01/robot/status');
    expect(topics).not.toContain('factory/line-01/secrets/token');
    expect(topics).not.toContain('warehouse/temperature');
    expect(JSON.stringify(answer)).not.toContain('hunter2');
  });

  it('reports that messages were refused, rather than hiding it', async () => {
    const answer = await engine.discover();

    expect(answer.coverage.deniedMessages).toBeGreaterThanOrEqual(1);
    expect(answer.limitations.map((limitation) => limitation.code)).toContain('MESSAGES_DENIED');
  });
});

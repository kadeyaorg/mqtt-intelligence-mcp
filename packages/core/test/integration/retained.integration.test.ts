/**
 * A retained state topic that keeps publishing is alive, and must be reported as alive.
 *
 * This is the one MQTT subtlety that no fake can settle, because it is the broker that
 * decides what the `retain` flag means on a delivery: a replay at subscribe time, or the
 * publisher's own intent carried through. Getting it wrong is not a cosmetic error — a
 * retained state topic is the single most common pattern in industrial MQTT, and misreading
 * it makes a whole live subtree look dead.
 *
 * Found against a real machine: the entire `plc/` subtree of a production line reported
 * "last live never" and a rate of 0 while publishing every 1.3 seconds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/index.js';
import {
  createEngine,
  parseBrokerId,
  parseConfigDocument,
  parseTopicName,
  resolveConfig,
} from '../../src/index.js';
import type { RunningMosquitto } from './mosquitto.js';
import { startMosquitto } from './mosquitto.js';
import { publishMessages } from './publisher.js';

const BROKER = parseBrokerId('factory-fr');
const TOPIC = parseTopicName('factory/line-01/plc/state');

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for a condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('a retained topic that keeps publishing', () => {
  let broker: RunningMosquitto;
  let engine: Engine;

  beforeAll(async () => {
    broker = await startMosquitto();

    // Published before anyone subscribes: this one really is a replay.
    await publishMessages(broker.url, [
      { topic: TOPIC, payload: 'STARTING', retain: true, qos: 1 },
    ]);

    const config = await resolveConfig(
      parseConfigDocument({
        version: 1,
        brokers: { 'factory-fr': { url: broker.url } },
        limits: { flushIntervalMs: 50 },
      }),
      { env: {} },
    );
    engine = createEngine(config);
    await engine.start();
    await engine.discover({ brokerId: BROKER });

    // The replay has to be in before the live publishes, or the two cannot be told apart.
    await waitFor(async () => {
      const answer = await engine.recentMessages({ brokerId: BROKER, topic: TOPIC });
      return answer.facts.messages.length > 0;
    });

    // Published while subscribed, with the retain flag set, exactly as a PLC does.
    for (const payload of ['RUNNING', 'FILLING', 'RUNNING']) {
      await publishMessages(broker.url, [{ topic: TOPIC, payload, retain: true, qos: 1 }]);
    }

    await waitFor(async () => {
      const answer = await engine.describeTopic({ brokerId: BROKER, topic: TOPIC });
      return answer.facts.messageCount >= 4;
    });
  }, 180_000);

  afterAll(async () => {
    await engine.close();
    await broker.stop();
  }, 60_000);

  it('counts the live publishes as live, not as replays', async () => {
    const answer = await engine.describeTopic({ brokerId: BROKER, topic: TOPIC });

    expect(answer.facts.messageCount).toBeGreaterThanOrEqual(4);
    // One replay at subscribe time; everything after it arrived live.
    expect(answer.facts.retainedReplayCount).toBe(1);
    expect(answer.facts.lastLiveAt).toBeDefined();
  });

  it('gives it a rate, so it does not look like a dead topic', async () => {
    const answer = await engine.describeTopic({ brokerId: BROKER, topic: TOPIC });

    expect(answer.observations?.messagesPerSecond).toBeGreaterThan(0);
  });

  it('finds it when asked what is active, and not when asked what has gone quiet', async () => {
    const since = Date.now() - 60_000;

    const active = await engine.searchTopics({ brokerId: BROKER, activeSince: since });
    const silent = await engine.searchTopics({ brokerId: BROKER, silentSince: since });

    expect(active.facts.topics.map((topic) => topic.topic)).toContain(TOPIC);
    expect(silent.facts.topics.map((topic) => topic.topic)).not.toContain(TOPIC);
  });

  it('still marks the message the broker replayed at subscribe time', async () => {
    const answer = await engine.recentMessages({ brokerId: BROKER, topic: TOPIC, limit: 50 });

    const replays = answer.facts.messages.filter((message) => message.retainedReplay);
    expect(replays).toHaveLength(1);
    expect(answer.facts.messages.at(-1)?.retainedReplay).toBe(true);
  });
});

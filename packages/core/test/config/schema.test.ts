import { describe, expect, it } from 'vitest';
import type { ConfigDocument } from '../../src/index.js';
import {
  ConfigError,
  CONFIG_VERSION,
  parseBrokerId,
  parseConfigDocument,
} from '../../src/index.js';

const FACTORY_FR = parseBrokerId('factory-fr');

const minimal = {
  version: CONFIG_VERSION,
  brokers: { 'factory-fr': { url: 'mqtt://localhost:1883' } },
};

function parse(document: unknown): ConfigDocument {
  return parseConfigDocument(document);
}

function expectIssue(document: unknown, expected: string): void {
  try {
    parseConfigDocument(document);
    expect.unreachable('should have been rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    const configError = error as ConfigError;
    expect(configError.code).toBe('CONFIG_INVALID');
    expect(configError.message).toContain(expected);
  }
}

describe('defaults', () => {
  it('turns a two-line configuration into a complete, safe one', () => {
    const config = parse(minimal);
    const broker = config.brokers[FACTORY_FR];

    expect(broker).toBeDefined();
    expect(broker?.protocolVersion).toBe(5);
    expect(broker?.connect).toBe('startup');
    expect(broker?.clientId).toEqual({ prefix: 'mqtt-observer' });
    expect(broker?.discovery).toEqual({
      enabled: true,
      filters: ['#'],
      includeSysTopics: false,
      subscriptionQos: 0,
    });
    expect(broker?.timeouts).toEqual({ connectMs: 10_000, keepaliveSeconds: 30 });
    expect(broker?.reconnect).toEqual({ initialDelayMs: 1000, maxDelayMs: 60_000 });
  });

  it('defaults to read-everything, deny-nothing, publish-disabled', () => {
    const config = parse(minimal);

    expect(config.security.read).toEqual({ allow: ['#'], deny: [] });
    expect(config.security.publish.enabled).toBe(false);
    expect(config.security.redaction.jsonKeys).toContain('password');
  });

  it('defaults every limit, so memory is bounded without any configuration', () => {
    const config = parse(minimal);

    expect(config.limits.maxTopicsPerBroker).toBe(50_000);
    expect(config.limits.onTopicLimit).toBe('evict-lru');
    expect(config.limits.flushIntervalMs).toBe(100);
    expect(config.storage.type).toBe('memory');
    expect(config.logging).toEqual({ level: 'info', format: 'json' });
  });

  it('keeps what the operator wrote', () => {
    const config = parse({
      ...minimal,
      brokers: {
        'factory-fr': {
          url: 'mqtts://mqtt.example.com:8883',
          protocolVersion: 4,
          connect: 'lazy',
          clientId: { fixed: 'supervision-01' },
          discovery: { filters: ['factory/#', '$SYS/#'], subscriptionQos: 1 },
        },
      },
      limits: { maxTopicsPerBroker: 10 },
      logging: { level: 'debug' },
    });

    expect(config.brokers[FACTORY_FR]?.protocolVersion).toBe(4);
    expect(config.brokers[FACTORY_FR]?.clientId).toEqual({ fixed: 'supervision-01' });
    expect(config.brokers[FACTORY_FR]?.discovery.filters).toEqual(['factory/#', '$SYS/#']);
    expect(config.brokers[FACTORY_FR]?.discovery.includeSysTopics).toBe(false);
    expect(config.limits.maxTopicsPerBroker).toBe(10);
    expect(config.logging).toEqual({ level: 'debug', format: 'json' });
  });
});

describe('rejections', () => {
  it('rejects an unknown key, because a misspelled security rule would not apply', () => {
    expectIssue(
      { ...minimal, security: { read: { allow: ['#'], denny: ['secret/#'] } } },
      'security.read',
    );
  });

  it('names the exact path of the offending key', () => {
    expectIssue(
      {
        ...minimal,
        brokers: { 'factory-fr': { url: 'mqtt://localhost:1883', auth: { password: 'hunter2' } } },
      },
      'brokers.factory-fr.auth.password: Plain-text secrets are not allowed',
    );
  });

  it.each([
    [
      'credentials inside the URL',
      { brokers: { b: { url: 'mqtt://alice:hunter2@localhost:1883' } } },
      'Credentials must not appear in the URL',
    ],
    [
      'an unsupported scheme',
      { brokers: { b: { url: 'https://localhost:443' } } },
      'Unsupported scheme',
    ],
    ['a malformed URL', { brokers: { b: { url: 'not a url' } } }, 'Not a valid URL'],
    [
      'an invalid topic filter',
      { brokers: { b: { url: 'mqtt://h:1883', discovery: { filters: ['a/#/b'] } } } },
      'Not a valid MQTT topic filter',
    ],
    [
      'an invalid broker id',
      { brokers: { 'Factory FR': { url: 'mqtt://h:1883' } } },
      'Broker id must be',
    ],
    ['no broker at all', { brokers: {} }, 'At least one broker is required'],
    [
      'a private key without its certificate',
      { brokers: { b: { url: 'mqtt://h:1883', tls: { key: { file: './client.key' } } } } },
      'Mutual TLS needs both',
    ],
    [
      'a secret reference with both sources',
      {
        brokers: {
          b: { url: 'mqtt://h:1883', auth: { password: { env: 'A', file: './b' } } },
        },
      },
      'brokers.b.auth.password',
    ],
    ['a limit outside its bounds', { limits: { flushIntervalMs: 1 } }, 'limits.flushIntervalMs'],
    [
      'storing more of a payload than is ever inspected',
      { limits: { maxInspectBytes: 1024, maxStoredPayloadBytes: 4096 } },
      'must not exceed limits.maxInspectBytes',
    ],
    [
      'a backoff that starts above its ceiling',
      {
        brokers: {
          b: { url: 'mqtt://h:1883', reconnect: { initialDelayMs: 30_000, maxDelayMs: 5000 } },
        },
      },
      'must not exceed reconnect.maxDelayMs',
    ],
  ])('rejects %s', (_case, overrides, expected) => {
    expectIssue({ ...minimal, ...overrides }, expected);
  });

  it('refuses to enable publishing, which does not exist in this version', () => {
    expectIssue(
      { ...minimal, security: { publish: { enabled: true } } },
      'Publishing is not implemented in this version',
    );
  });

  it.each([
    ['a missing version', { brokers: minimal.brokers }],
    ['a future version', { version: 2, brokers: minimal.brokers }],
  ])('rejects %s', (_case, document) => {
    expectIssue(document, 'version');
  });

  it('rejects a document that is not an object', () => {
    expectIssue('brokers: everything', '(root)');
  });

  it('reports several problems at once, so a configuration can be fixed in one pass', () => {
    try {
      parseConfigDocument({
        version: CONFIG_VERSION,
        brokers: { b: { url: 'nope', discovery: { filters: ['#/x'] } } },
      });
      expect.unreachable('should have been rejected');
    } catch (error) {
      const configError = error as ConfigError;
      expect(configError.details['issueCount']).toBeGreaterThanOrEqual(2);
      expect(configError.message).toContain('brokers.b.url');
      expect(configError.message).toContain('brokers.b.discovery.filters[0]');
    }
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineConfig } from '../../src/index.js';
import {
  buildQuickStartDocument,
  ConfigError,
  CONFIG_PATH_ENV,
  loadConfig,
  loadConfigFile,
  parseBrokerId,
  parseConfigText,
  QUICK_START_ENV,
  resolveConfig,
  Secret,
} from '../../src/index.js';

const PASSWORD = 'sup3r-s3cret';
const FACTORY = parseBrokerId('factory-fr');

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mqtt-intel-config-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function writeConfig(contents: string, name = 'config.yaml'): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, contents, 'utf8');
  return path;
}

async function expectConfigError(
  operation: Promise<unknown>,
  code: string,
  messageFragment: string,
): Promise<void> {
  const outcome: unknown = await operation.then(
    () => undefined,
    (reason: unknown) => reason,
  );

  expect(outcome).toBeInstanceOf(ConfigError);
  const error = outcome as ConfigError;
  expect(error.code).toBe(code);
  expect(error.message).toContain(messageFragment);
}

describe('loading a file', () => {
  it('loads YAML, resolves secrets, and leaves the password wrapped', async () => {
    const path = await writeConfig(`
version: 1
brokers:
  factory-fr:
    url: mqtts://mqtt.example.com:8883
    auth:
      username: supervision
      password:
        env: MQTT_FR_PASSWORD
`);

    const config = await loadConfigFile(path, { env: { MQTT_FR_PASSWORD: PASSWORD } });
    const broker = config.brokers.get(FACTORY);

    expect(broker?.url).toBe('mqtts://mqtt.example.com:8883');
    expect(broker?.auth?.username).toBe('supervision');
    expect(broker?.auth?.password).toBeInstanceOf(Secret);
    expect(broker?.auth?.password?.reveal()).toBe(PASSWORD);
    expect(broker?.auth?.password?.source).toBe('env:MQTT_FR_PASSWORD');
  });

  it('accepts JSON, which is valid YAML', async () => {
    const path = await writeConfig(
      JSON.stringify({ version: 1, brokers: { 'factory-fr': { url: 'mqtt://h:1883' } } }),
      'config.json',
    );

    const config = await loadConfigFile(path);

    expect(config.brokers.get(FACTORY)?.url).toBe('mqtt://h:1883');
  });

  it('reads a secret from a file, dropping the trailing newline a shell would add', async () => {
    await writeFile(join(directory, 'password.txt'), `${PASSWORD}\n`, 'utf8');
    const path = await writeConfig(`
version: 1
brokers:
  factory-fr:
    url: mqtt://h:1883
    auth:
      password:
        file: ./password.txt
`);

    const config = await loadConfigFile(path);

    expect(config.brokers.get(FACTORY)?.auth?.password?.reveal()).toBe(PASSWORD);
  });

  it('resolves relative paths against the file, not the working directory', async () => {
    await writeFile(join(directory, 'ca.pem'), 'CA MATERIAL', 'utf8');
    await writeFile(join(directory, 'client.pem'), 'CERT MATERIAL', 'utf8');
    await writeFile(join(directory, 'client.key'), 'KEY MATERIAL', 'utf8');
    const path = await writeConfig(`
version: 1
brokers:
  factory-fr:
    url: mqtts://h:8883
    tls:
      ca:
        file: ./ca.pem
      cert:
        file: ./client.pem
      key:
        file: ./client.key
      alpn: [x-amzn-mqtt-ca]
`);

    const tls = (await loadConfigFile(path)).brokers.get(FACTORY)?.tls;

    expect(new TextDecoder().decode(tls?.ca)).toBe('CA MATERIAL');
    expect(new TextDecoder().decode(tls?.cert)).toBe('CERT MATERIAL');
    expect(tls?.key).toBeInstanceOf(Secret);
    expect(new TextDecoder().decode(tls?.key?.reveal())).toBe('KEY MATERIAL');
    expect(tls?.alpn).toEqual(['x-amzn-mqtt-ca']);
    expect(tls?.rejectUnauthorized).toBe(true);
  });

  it.each([
    [
      'the environment variable is missing',
      'auth:\n      password:\n        env: MQTT_FR_PASSWORD',
      'environment variable MQTT_FR_PASSWORD is not set',
    ],
    [
      'the secret file is missing',
      'auth:\n      password:\n        file: ./nowhere.txt',
      'file not found',
    ],
    [
      'the TLS material is missing',
      'tls:\n      ca:\n        file: ./nowhere.pem',
      'brokers.factory-fr.tls.ca: file not found',
    ],
  ])('reports CONFIG_SECRET_UNRESOLVED when %s', async (_case, fragment, expected) => {
    const path = await writeConfig(`
version: 1
brokers:
  factory-fr:
    url: mqtt://h:1883
    ${fragment}
`);

    await expectConfigError(
      loadConfigFile(path, { env: {} }),
      'CONFIG_SECRET_UNRESOLVED',
      expected,
    );
  });

  it('rejects a secret file that contains nothing but a newline', async () => {
    await writeFile(join(directory, 'password.txt'), '\n', 'utf8');
    const path = await writeConfig(`
version: 1
brokers:
  factory-fr:
    url: mqtt://h:1883
    auth:
      password:
        file: ./password.txt
`);

    await expectConfigError(loadConfigFile(path), 'CONFIG_SECRET_UNRESOLVED', 'file is empty');
  });

  it('accepts a username held in a secret store, and a key passphrase', async () => {
    await writeFile(join(directory, 'client.pem'), 'CERT', 'utf8');
    await writeFile(join(directory, 'client.key'), 'KEY', 'utf8');
    const path = await writeConfig(`
version: 1
brokers:
  factory-fr:
    url: mqtts://h:8883
    clientId:
      fixed: supervision-01
    auth:
      username:
        env: MQTT_FR_USERNAME
    tls:
      cert:
        file: ./client.pem
      key:
        file: ./client.key
      keyPassphrase:
        env: MQTT_FR_KEY_PASSPHRASE
`);

    const config = await loadConfigFile(path, {
      env: { MQTT_FR_USERNAME: 'supervision', MQTT_FR_KEY_PASSPHRASE: 'phrase' },
    });
    const broker = config.brokers.get(FACTORY);

    expect(broker?.clientId).toEqual({ kind: 'fixed', value: 'supervision-01' });
    expect(broker?.auth?.username).toBeInstanceOf(Secret);
    expect((broker?.auth?.username as Secret).reveal()).toBe('supervision');
    expect(broker?.tls?.keyPassphrase?.reveal()).toBe('phrase');
  });

  it('reports a missing configuration file by path', async () => {
    await expectConfigError(
      loadConfigFile(join(directory, 'absent.yaml')),
      'CONFIG_INVALID',
      'file not found',
    );
  });

  it.each([
    ['malformed YAML', 'brokers: [unclosed', 'Cannot parse'],
    ['an empty file', '', 'is empty'],
  ])('rejects %s', async (_case, contents, expected) => {
    const path = await writeConfig(contents);

    await expectConfigError(loadConfigFile(path), 'CONFIG_INVALID', expected);
  });
});

describe('quick start from the environment', () => {
  it('builds a single-broker configuration from MQTT_URL alone', async () => {
    const config = await loadConfig({ env: { [QUICK_START_ENV.url]: 'mqtt://localhost:1883' } });
    const broker = config.brokers.get(parseBrokerId('default'));

    expect(config.brokers.size).toBe(1);
    expect(broker?.url).toBe('mqtt://localhost:1883');
    expect(broker?.discovery.filters).toEqual(['#']);
  });

  it('takes credentials and a broker id from the environment', async () => {
    const config = await loadConfig({
      env: {
        [QUICK_START_ENV.url]: 'mqtt://localhost:1883',
        [QUICK_START_ENV.username]: 'supervision',
        [QUICK_START_ENV.password]: PASSWORD,
        [QUICK_START_ENV.brokerId]: 'staging',
      },
    });
    const broker = config.brokers.get(parseBrokerId('staging'));

    expect(broker?.auth?.username).toBe('supervision');
    expect(broker?.auth?.password?.reveal()).toBe(PASSWORD);
  });

  it('returns no document when MQTT_URL is unset', () => {
    expect(buildQuickStartDocument({})).toBeUndefined();
  });

  it('validates the quick start like any other configuration', () => {
    expect(() => buildQuickStartDocument({ [QUICK_START_ENV.url]: 'https://h' })).toThrow(
      ConfigError,
    );
  });

  it('prefers an explicit path over the environment', async () => {
    const path = await writeConfig(
      'version: 1\nbrokers:\n  from-file:\n    url: mqtt://file:1883\n',
    );

    const config = await loadConfig({
      path,
      env: { [QUICK_START_ENV.url]: 'mqtt://env:1883' },
    });

    expect(config.brokers.get(parseBrokerId('from-file'))?.url).toBe('mqtt://file:1883');
  });

  it(`reads the path from ${CONFIG_PATH_ENV}`, async () => {
    const path = await writeConfig(
      'version: 1\nbrokers:\n  from-env-path:\n    url: mqtt://file:1883\n',
    );

    const config = await loadConfig({ env: { [CONFIG_PATH_ENV]: path } });

    expect(config.brokers.has(parseBrokerId('from-env-path'))).toBe(true);
  });

  it('explains what to do when nothing is configured', async () => {
    await expectConfigError(loadConfig({ env: {} }), 'CONFIG_INVALID', QUICK_START_ENV.url);
  });
});

describe('resolved configuration', () => {
  async function resolve(yaml: string): Promise<EngineConfig> {
    return resolveConfig(parseConfigText(yaml, 'test'), { env: {}, baseDir: directory });
  }

  it('merges read policies: deny lists accumulate, an allow list narrows one broker', async () => {
    const config = await resolve(`
version: 1
security:
  read:
    allow: ['#']
    deny: ['+/+/secrets/#']
brokers:
  factory-fr:
    url: mqtt://h:1883
    security:
      read:
        allow: ['factory/#']
        deny: ['factory/line-01/private/#']
  staging:
    url: mqtt://h:1884
`);

    expect(config.brokers.get(FACTORY)?.readPolicy).toEqual({
      allow: ['factory/#'],
      deny: ['+/+/secrets/#', 'factory/line-01/private/#'],
    });
    expect(config.brokers.get(parseBrokerId('staging'))?.readPolicy).toEqual({
      allow: ['#'],
      deny: ['+/+/secrets/#'],
    });
  });

  it('lowercases redaction keys so matching is case-insensitive later', async () => {
    const config = await resolve(`
version: 1
security:
  redaction:
    jsonKeys: [Password, API_KEY]
brokers:
  factory-fr:
    url: mqtt://h:1883
`);

    expect(config.security.redaction.jsonKeys).toEqual(['password', 'api_key']);
  });

  it('is frozen, so nothing can quietly widen the policy at runtime', async () => {
    const config = await resolve('version: 1\nbrokers:\n  factory-fr:\n    url: mqtt://h:1883\n');
    const broker = config.brokers.get(FACTORY);

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.limits)).toBe(true);
    expect(Object.isFrozen(broker)).toBe(true);
    expect(Object.isFrozen(broker?.readPolicy.deny)).toBe(true);
    expect(() => {
      (broker?.readPolicy.deny as unknown as string[]).push('#');
    }).toThrow(TypeError);
  });

  it('never exposes a secret when the whole configuration is serialized or inspected', async () => {
    await writeFile(join(directory, 'client.key'), 'KEY MATERIAL', 'utf8');
    await writeFile(join(directory, 'client.pem'), 'CERT', 'utf8');
    const config = await resolveConfig(
      parseConfigText(
        `
version: 1
brokers:
  factory-fr:
    url: mqtts://h:8883
    auth:
      password:
        env: MQTT_FR_PASSWORD
    tls:
      cert:
        file: ./client.pem
      key:
        file: ./client.key
`,
        'test',
      ),
      { env: { MQTT_FR_PASSWORD: PASSWORD }, baseDir: directory },
    );

    const serialized = JSON.stringify({ brokers: [...config.brokers.values()] });
    const inspected = inspect(config, { depth: 10 });

    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain('KEY MATERIAL');
    expect(inspected).not.toContain(PASSWORD);
    expect(inspected).not.toContain('KEY MATERIAL');
  });
});

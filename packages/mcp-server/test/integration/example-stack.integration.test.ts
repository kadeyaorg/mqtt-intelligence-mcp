/**
 * The published example, end to end: a real broker, a real simulator, the real binary.
 *
 * Everything else in this repository is tested against fakes or a bare Mosquitto. This suite
 * exists for a different reason: an example that does not work is worse than no example,
 * because it is the first thing a reader copies. So it starts the Docker Compose stack a user
 * would start, runs the `check` a user would run, and then holds an MCP session and asks the
 * questions the README tells them to ask.
 *
 * It also pins the two security claims that README makes: a denied topic appears in no
 * answer, and a credential in a payload is redacted before it leaves the server.
 *
 * The stack is published on a free port rather than on 1883, and the example configuration is
 * copied with its URL adjusted. Developers' machines often already run a broker there, and a
 * suite that silently talks to the wrong one would report "no topics" and mean "wrong
 * broker". The copy is checked to differ from the shipped file in exactly that one place, so
 * what is tested is still the example that ships.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const COMPOSE = fileURLToPath(
  new URL('../../../../examples/industrial-machine/docker-compose.yml', import.meta.url),
);
const SHIPPED_CONFIG = fileURLToPath(
  new URL('../../../../examples/industrial-machine/mqtt-intelligence.yaml', import.meta.url),
);
const BIN = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));

/** The URL the shipped example uses. Changing it there must change it here. */
const SHIPPED_URL = 'mqtt://localhost:1883';

/** Pulling an image and installing the simulator's dependency takes a while on a cold runner. */
const STACK_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 120_000;

interface ToolResult {
  readonly content: readonly { readonly text?: string }[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

function textOf(result: ToolResult): string {
  return result.content.map((item) => item.text ?? '').join('\n');
}

/** A port the operating system has just confirmed is free. */
async function freeHostPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

let directory = '';
let configPath: string;
let hostPort: number;
let client: Client;

async function compose(...args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return run('docker', ['compose', '-f', COMPOSE, ...args], {
    cwd: ROOT,
    timeout: STACK_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, MQTT_EXAMPLE_HOST_PORT: String(hostPort) },
  });
}

beforeAll(async () => {
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} is missing. Run "npm run build" before the integration tests.`);
  }

  hostPort = await freeHostPort();
  const shipped = await readFile(SHIPPED_CONFIG, 'utf8');
  // If this fails, the example's URL changed and this suite would have tested a stale copy.
  expect(shipped, `${SHIPPED_CONFIG} no longer uses ${SHIPPED_URL}`).toContain(SHIPPED_URL);

  directory = await mkdtemp(join(tmpdir(), 'mqtt-intelligence-example-'));
  configPath = join(directory, 'mqtt-intelligence.yaml');
  await writeFile(
    configPath,
    shipped.replace(SHIPPED_URL, `mqtt://127.0.0.1:${String(hostPort)}`),
    'utf8',
  );

  await compose('up', '-d', '--build', '--wait');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, '--config', configPath],
    env: { PATH: process.env['PATH'] ?? '' },
    stderr: 'pipe',
  });
  client = new Client({ name: 'example-stack-test', version: '1.0.0' });
  await client.connect(transport);
}, STACK_TIMEOUT_MS);

afterAll(async () => {
  // Tearing down must not depend on how far the set-up got: a stack left running would break
  // the next run too.
  try {
    await client.close();
  } catch {
    // The session may never have opened.
  }
  await compose('down', '-v', '--remove-orphans').catch(() => undefined);
  if (directory !== '') {
    await rm(directory, { recursive: true, force: true });
  }
}, STACK_TIMEOUT_MS);

describe('the example stack', () => {
  it(
    'passes the check the README tells a reader to run',
    async () => {
      const { stderr } = await run(process.execPath, [BIN, 'check', '--config', configPath], {
        cwd: ROOT,
        timeout: TEST_TIMEOUT_MS,
      });

      // execFile rejects on a non-zero exit, so reaching here is already exit code 0.
      expect(stderr).toContain('connection: ok');
      expect(stderr).toContain('subscribed to factory/#');
      expect(stderr).toContain('all 1 broker(s) passed');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'discovers the fictional line',
    async () => {
      const result = (await client.callTool({
        name: 'mqtt_discover_topics',
        arguments: { waitSeconds: 8 },
      })) as unknown as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('factory');
      const { facts } = result.structuredContent as {
        facts: { brokerId: string; topicCount: number };
      };
      expect(facts.brokerId).toBe('factory-fr');
      // The simulator publishes ten topics; eight is a floor that tolerates a slow start.
      expect(facts.topicCount).toBeGreaterThanOrEqual(8);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'finds the robot the README asks about',
    async () => {
      const result = (await client.callTool({
        name: 'mqtt_search_topics',
        arguments: { text: 'robot' },
      })) as unknown as ToolResult;

      const text = textOf(result);
      expect(text).toContain('factory/line-01/robot/status');
      expect(text).toContain('factory/line-01/robot/position');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'never shows the denied topic, although the simulator keeps publishing it',
    async () => {
      const search = (await client.callTool({
        name: 'mqtt_search_topics',
        arguments: { text: 'credentials' },
      })) as unknown as ToolResult;
      const tree = (await client.callTool({
        name: 'mqtt_topic_tree',
        arguments: { depth: 6 },
      })) as unknown as ToolResult;

      expect(JSON.stringify(search)).not.toContain('credentials/rotate');
      expect(JSON.stringify(tree)).not.toContain('credentials');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'redacts the credential in the retained metadata, and says it was a retained replay',
    async () => {
      const result = (await client.callTool({
        name: 'mqtt_get_recent_messages',
        arguments: { topic: 'factory/site/metadata' },
      })) as unknown as ToolResult;

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('demo-key-not-a-real-secret');
      expect(serialized).toContain('[REDACTED]');
      expect(textOf(result)).toContain('retained replay');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps facts and observations apart when describing a topic',
    async () => {
      const result = (await client.callTool({
        name: 'mqtt_describe_topic',
        arguments: { topic: 'factory/line-01/plc/heartbeat' },
      })) as unknown as ToolResult;
      const text = textOf(result);

      expect(text).toContain('FACTS');
      expect(text).toContain('OBSERVATIONS');
      expect(text).toContain('LIMITATIONS');
    },
    TEST_TIMEOUT_MS,
  );
});

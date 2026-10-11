/**
 * The real binary, in a real process, over real pipes.
 *
 * Everything else about this server can be tested in memory; these four things cannot, and
 * they are the ones a user meets first: the exit code, that stdout carries protocol frames
 * and nothing else, that an MCP client gets its tools, and that the process actually leaves
 * when its client closes the pipe.
 *
 * These tests run the compiled output, so the package must be built first (`npm run build`,
 * which `npm run check` and every CI job do before running the tests).
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));

/** Node start-up plus a connection attempt, on the slowest CI runner. */
const SPAWN_TIMEOUT_MS = 30_000;

/** An address nothing listens on: the broker fails fast and the server still serves. */
const UNREACHABLE = 'mqtt://127.0.0.1:1';

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} is missing. Run "npm run build" before the tests.`);
  }
});

interface Completed {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runBinary(args: readonly string[], env: Record<string, string> = {}): Promise<Completed> {
  return new Promise<Completed>((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      // A clean environment, so a developer's own MQTT_URL cannot change the outcome.
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

describe('the binary', () => {
  it(
    'prints the help to stderr and leaves stdout empty',
    async () => {
      const result = await runBinary(['--help']);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('USAGE');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'prints the version to stderr, not to stdout',
    async () => {
      const result = await runBinary(['--version']);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toMatch(/^\d+\.\d+\.\d+/);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'exits 2 on an argument it cannot understand',
    async () => {
      const result = await runBinary(['--nope']);

      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'exits 3 when no configuration is available',
    async () => {
      const result = await runBinary(['check']);

      expect(result.code).toBe(3);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'exits 4 when check reaches no broker',
    async () => {
      const result = await runBinary(['check'], { MQTT_URL: UNREACHABLE });

      expect(result.code).toBe(4);
      expect(result.stderr).toContain('FAILED');
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('serving over real stdio', () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it(
    'answers tools/list to an MCP client that spawned it',
    async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [BIN],
        env: { PATH: process.env['PATH'] ?? '', MQTT_URL: UNREACHABLE },
        stderr: 'pipe',
      });
      client = new Client({ name: 'spawn-test-client', version: '1.0.0' });
      await client.connect(transport);

      const listed = await client.listTools();

      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        'mqtt_describe_topic',
        'mqtt_discover_topics',
        'mqtt_get_recent_messages',
        'mqtt_list_brokers',
        'mqtt_search_topics',
        'mqtt_topic_tree',
      ]);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('a served session, byte for byte', () => {
  let child: ChildProcessWithoutNullStreams | undefined;

  afterEach(() => {
    child?.kill();
    child = undefined;
  });

  it(
    'writes nothing but JSON-RPC frames to stdout, and exits 0 when stdin closes',
    async () => {
      child = spawn(process.execPath, [BIN], {
        env: { PATH: process.env['PATH'] ?? '', MQTT_URL: UNREACHABLE },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const current = child;
      let stdout = '';
      current.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      current.stderr.resume();

      const exited = new Promise<number | null>((resolve) => {
        current.on('close', (code) => {
          resolve(code);
        });
      });
      const firstResponse = new Promise<void>((resolve) => {
        current.stdout.on('data', () => {
          if (stdout.includes('\n')) {
            resolve();
          }
        });
      });

      // A claim-less opening, which the stdio entry serves as a 2025-era session. The point
      // here is not the era: it is that whatever comes back is a frame and nothing else.
      current.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'raw', version: '1.0.0' },
          },
        })}\n`,
      );
      await firstResponse;

      // Closing stdin is how an MCP client stops a stdio server.
      current.stdin.end();

      expect(await exited).toBe(0);

      const lines = stdout.split('\n').filter((line) => line.trim() !== '');
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const frame: unknown = JSON.parse(line);
        expect(frame).toMatchObject({ jsonrpc: '2.0' });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('shutdown by signal', () => {
  // Windows has no POSIX signals: `kill` there terminates the process without running a
  // handler, so there is nothing to assert. Containers and service managers, which is where
  // signals matter, are Unix.
  it.skipIf(process.platform === 'win32')(
    'stops on SIGTERM and exits 0',
    async () => {
      const child = spawn(process.execPath, [BIN], {
        env: { PATH: process.env['PATH'] ?? '', MQTT_URL: UNREACHABLE },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exited = new Promise<number | null>((resolve) => {
        child.on('close', (code) => {
          resolve(code);
        });
      });

      // The server logs this on stderr once it is serving; before that, a signal would be
      // testing the wrong thing.
      await new Promise<void>((resolve) => {
        let stderr = '';
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk;
          if (stderr.includes('Serving MCP over stdio')) {
            resolve();
          }
        });
      });
      child.kill('SIGTERM');

      expect(await exited).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );
});

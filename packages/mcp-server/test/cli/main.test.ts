/**
 * `runCli` without a subprocess: the classification of every outcome into an exit code.
 *
 * The exit code is the only thing a supervisor or an MCP client launcher reads before it
 * reads anything else, so each one is pinned here. Spawn tests cover the real binary; this
 * file covers the decisions.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { runCli } from '../../src/cli/main.js';
import type { CliOutput } from '../../src/cli/output.js';

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

interface Outcome {
  readonly code: number;
  readonly text: string;
}

/** Runs the CLI in this process, capturing everything it would have written to stderr. */
async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<Outcome> {
  const chunks: string[] = [];
  const out: CliOutput = {
    write(text: string): void {
      chunks.push(text);
    },
  };
  const code = await runCli({ argv, env, out });
  return { code, text: chunks.join('') };
}

/** Writes a configuration file. JSON is valid YAML, so the document can stay inline. */
async function writeConfig(document: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mqtt-intelligence-cli-'));
  directories.push(directory);
  const path = join(directory, 'config.yaml');
  await writeFile(path, JSON.stringify(document), 'utf8');
  return path;
}

/** An address nothing listens on: the connection is refused rather than timing out. */
const UNREACHABLE = 'mqtt://127.0.0.1:1';

describe('help and version', () => {
  it('print the usage, the exit codes and the environment variables', async () => {
    const { code, text } = await run(['--help']);

    expect(code).toBe(EXIT_CODES.success);
    expect(text).toContain('USAGE');
    expect(text).toContain('EXIT CODES');
    expect(text).toContain('MQTT_INTELLIGENCE_CONFIG');
    expect(text).toContain('MQTT_URL');
  });

  it('say that stdout carries protocol frames only', async () => {
    const { text } = await run(['--help']);

    expect(text).toContain('stdout carries MCP protocol frames only');
  });

  it('print a version on its own line', async () => {
    const { code, text } = await run(['--version']);

    expect(code).toBe(EXIT_CODES.success);
    expect(text.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('a command line that cannot be understood', () => {
  it('exits 2 and points at --help', async () => {
    const { code, text } = await run(['--nope']);

    expect(code).toBe(EXIT_CODES.usage);
    expect(text).toContain('--help');
  });

  it('starts nothing: an unknown command never reaches the configuration', async () => {
    // No configuration at all: were the command run, this would fail as a config error (3).
    const { code } = await run(['frobnicate']);

    expect(code).toBe(EXIT_CODES.usage);
  });
});

describe('a configuration that cannot be loaded', () => {
  it('exits 3 when there is none, and says how to provide one', async () => {
    const { code, text } = await run(['check']);

    expect(code).toBe(EXIT_CODES.configuration);
    expect(text).toContain('MQTT_URL');
    expect(text).toContain('MQTT_INTELLIGENCE_CONFIG');
  });

  it('exits 3 when the file is missing, and names it', async () => {
    const { code, text } = await run(['check', '--config', 'no-such-file.yaml']);

    expect(code).toBe(EXIT_CODES.configuration);
    expect(text).toContain('no-such-file.yaml');
  });

  it('exits 3 when the file is invalid, and says which field is wrong', async () => {
    const path = await writeConfig({ version: 1, brokers: { bad: { url: 'ftp://nope' } } });

    const { code, text } = await run(['check', '--config', path]);

    expect(code).toBe(EXIT_CODES.configuration);
    expect(text).toContain('brokers.bad.url');
  });

  it('reads the path from the environment when --config is absent', async () => {
    const path = await writeConfig({ version: 1, brokers: { bad: { url: 'ftp://nope' } } });

    const { code } = await run(['check'], { MQTT_INTELLIGENCE_CONFIG: path });

    expect(code).toBe(EXIT_CODES.configuration);
  });
});

describe('check', () => {
  it('exits 4 when a broker cannot be reached, and says which one', async () => {
    const path = await writeConfig({
      version: 1,
      brokers: { 'factory-fr': { url: UNREACHABLE, timeouts: { connectMs: 1000 } } },
      logging: { level: 'error' },
    });

    const { code, text } = await run(['check', '--config', path]);

    expect(code).toBe(EXIT_CODES.checkFailed);
    expect(text).toContain('Configuration: valid, 1 broker(s).');
    expect(text).toContain('factory-fr');
    expect(text).toContain('FAILED');
    expect(text).toContain('Result: 1 of 1 broker(s) FAILED.');
  });

  it('reports every broker, not just the first to fail', async () => {
    const path = await writeConfig({
      version: 1,
      brokers: {
        'factory-fr': { url: UNREACHABLE, timeouts: { connectMs: 1000 } },
        staging: { url: UNREACHABLE, timeouts: { connectMs: 1000 } },
      },
      logging: { level: 'error' },
    });

    const { code, text } = await run(['check', '--config', path]);

    expect(code).toBe(EXIT_CODES.checkFailed);
    expect(text).toContain('staging');
    expect(text).toContain('Result: 2 of 2 broker(s) FAILED.');
  });

  it('surfaces a disabled certificate verification before it connects anything', async () => {
    const path = await writeConfig({
      version: 1,
      brokers: {
        lax: {
          url: 'mqtts://127.0.0.1:1',
          timeouts: { connectMs: 1000 },
          tls: { rejectUnauthorized: false },
        },
      },
      logging: { level: 'error' },
    });

    const { text } = await run(['check', '--config', path]);

    expect(text).toContain('TLS on, certificate verification DISABLED');
  });

  it('works from the file-less quick start', async () => {
    // The quick start has no logging section, so the engine logs its failed attempt to the
    // real stderr at warn level. That one line in the test output is expected.
    const { code, text } = await run(['check'], {
      MQTT_URL: UNREACHABLE,
      MQTT_BROKER_ID: 'quick',
    });

    expect(code).toBe(EXIT_CODES.checkFailed);
    expect(text).toContain('quick');
  });
});

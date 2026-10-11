/**
 * The help text.
 *
 * It documents the exit codes and the environment variables, because the people who need
 * them most — someone whose MCP client shows a server that failed to start — have only
 * stderr and an exit code to work with.
 */
import { CONFIG_PATH_ENV, QUICK_START_ENV } from '@kadeya/mqtt-intel-core';
import { EXIT_CODES } from './exit-codes.js';

export const BINARY_NAME = 'mqtt-intel-mcp';

/** Two aligned columns, so the names stay readable whatever their length. */
function describe(rows: readonly (readonly [string, string])[]): readonly string[] {
  const width = Math.max(...rows.map(([name]) => name.length));
  return rows.map(([name, text]) => `  ${name.padEnd(width)}   ${text}`);
}

export function helpText(version: string): readonly string[] {
  return [
    `${BINARY_NAME} ${version} — MQTT Intelligence MCP server`,
    '',
    'Gives an AI agent read-only, structured and observable access to MQTT brokers over the',
    'Model Context Protocol. It never publishes to a broker.',
    '',
    'USAGE',
    `  ${BINARY_NAME} [serve] [--config <file>]   Serve MCP over stdio (the default)`,
    `  ${BINARY_NAME} check   [--config <file>]   Validate the configuration and the brokers`,
    '',
    'OPTIONS',
    '  -c, --config <file>   Configuration file (YAML or JSON)',
    '  -h, --help            Show this help',
    '  -v, --version         Show the version',
    '',
    'ENVIRONMENT',
    ...describe([
      [CONFIG_PATH_ENV, 'Configuration file, used when --config is absent'],
      [QUICK_START_ENV.url, 'Single-broker quick start, e.g. mqtt://localhost:1883'],
      [QUICK_START_ENV.brokerId, 'Name of that broker (default: "default")'],
      [QUICK_START_ENV.username, 'Username for that broker'],
      [QUICK_START_ENV.password, 'Password for that broker'],
    ]),
    '',
    'EXIT CODES',
    `  ${String(EXIT_CODES.success)}   Success. "serve" also exits 0 after a graceful shutdown.`,
    `  ${String(EXIT_CODES.unexpected)}   Unexpected failure.`,
    `  ${String(EXIT_CODES.usage)}   The command line could not be understood. Nothing was started.`,
    `  ${String(EXIT_CODES.configuration)}   Missing or invalid configuration. Nothing was connected.`,
    `  ${String(EXIT_CODES.checkFailed)}   "check" ran and at least one broker failed.`,
    '',
    'NOTES',
    '  stdout carries MCP protocol frames only. Everything else, this help included, goes to',
    '  stderr, which is where MCP clients collect a server’s output.',
    '  "serve" shuts down on SIGINT, SIGTERM, or when its standard input is closed.',
    '  "check" reports what the broker accepted. A broker may accept a subscription and then',
    '  deliver nothing on it, which no client can detect: its ACLs remain authoritative.',
    '',
    'EXAMPLES',
    `  MQTT_URL=mqtt://localhost:1883 ${BINARY_NAME} check`,
    `  ${BINARY_NAME} --config ./mqtt-intelligence.yaml`,
    '',
    'Documentation: https://github.com/kadeyaorg/mqtt-intelligence-mcp',
  ];
}

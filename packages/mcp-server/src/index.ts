/**
 * Public API of the MQTT Intelligence MCP server (`@kadeya/mqtt-intel-mcp`).
 *
 * Everything exported from this file is public API under semver. The tool names, their
 * schemas and their error codes are part of it too: prompts depend on them (ADR-0012). So
 * are the CLI's exit codes, which a supervisor reads before it reads anything else.
 */
export { createMcpServer } from './server.js';
export type { McpServerOptions } from './server.js';

export { runCli } from './cli/main.js';
export type { CliContext } from './cli/main.js';

export { runServe } from './cli/serve.js';
export type { ShutdownReason } from './cli/serve.js';

export { EXIT_CODES } from './cli/exit-codes.js';
export type { ExitCode } from './cli/exit-codes.js';

export { stderrOutput } from './cli/output.js';
export type { CliOutput } from './cli/output.js';

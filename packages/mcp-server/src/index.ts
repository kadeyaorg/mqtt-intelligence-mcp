/**
 * Public API of the MQTT Intelligence MCP server (`@kadeya/mqtt-intel-mcp`).
 *
 * Everything exported from this file is public API under semver. The tool names, their
 * schemas and their error codes are part of it too: prompts depend on them (ADR-0012).
 */
export { createMcpServer } from './server.js';
export type { McpServerOptions } from './server.js';

/**
 * Turning engine errors into something an agent can act on (ADR-0014).
 *
 * A failed tool call comes back as a **result** with `isError`, not as a protocol error:
 * the agent sees it, can read the code, and can correct itself — asking for the right broker,
 * waiting for a connection, or giving up for a documented reason. Protocol errors are
 * reserved for malformed requests, which the SDK already handles.
 *
 * Internal failures are the exception: they return a correlation id and nothing else, with
 * the detail going to the log, since an unexpected error may quote anything.
 */
import { isMqttIntelligenceError, type Logger } from '@kadeya/mqtt-intel-core';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { randomUUID } from 'node:crypto';

/** Hints that turn a refusal into a next step the agent can take by itself. */
const HINTS: Record<string, string> = {
  BROKER_AMBIGUOUS: 'Pass the "broker" argument naming one of the configured brokers.',
  BROKER_NOT_FOUND: 'Call mqtt_list_brokers to see the configured broker ids.',
  BROKER_UNAVAILABLE: 'The broker is not connected yet. Retry shortly, or check mqtt_list_brokers.',
  BROKER_AUTH_FAILED:
    'The broker refused the credentials. This needs a configuration change; retrying will not help.',
  ACCESS_DENIED:
    'The read policy forbids this. This is a configuration decision, not a transient failure.',
  TOPIC_NOT_OBSERVED:
    'Nothing has been observed on that topic yet. Try mqtt_discover_topics with a wait, or mqtt_search_topics to find the exact name.',
  CANCELLED: 'The call was cancelled.',
  INVALID_TOPIC:
    'Check the topic or filter syntax: "+" matches one level, "#" matches a subtree and must come last.',
};

export function toToolError(error: unknown, logger: Logger, tool: string): CallToolResult {
  if (isMqttIntelligenceError(error) && error.code !== 'INTERNAL') {
    const hint = HINTS[error.code];
    return {
      content: [
        {
          type: 'text',
          text: `${error.code}: ${error.message}${hint === undefined ? '' : `\nHint: ${hint}`}`,
        },
      ],
      isError: true,
    };
  }

  // Unexpected: the agent gets an id, the operator gets the detail.
  const correlationId = randomUUID();
  logger.error('A tool call failed unexpectedly', { tool, correlationId, error });
  return {
    content: [
      {
        type: 'text',
        text: `INTERNAL: The server hit an unexpected error. Correlation id ${correlationId} is in the server log.`,
      },
    ],
    isError: true,
  };
}

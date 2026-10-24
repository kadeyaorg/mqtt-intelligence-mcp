/**
 * `serve`: the MCP server over stdio, and the shutdown that goes with it.
 *
 * An MCP client starts this process, speaks JSON-RPC over its stdin and stdout, and stops it
 * by closing that pipe or by sending a signal. All three endings are the same ending, so
 * they are handled in one place.
 *
 * Once our own listeners are removed, a second SIGINT terminates the process the way Node
 * does by default, which is the right answer to an operator pressing Ctrl-C twice.
 */
import type { Engine, Logger } from '@kadeya/mqtt-intelligence-core';
import { describeError } from '@kadeya/mqtt-intelligence-core';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer } from '../server.js';
import { closeWithDeadline } from './close.js';
import { EXIT_CODES } from './exit-codes.js';

/** Signals an operator or a supervisor uses to stop a server. */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export type ShutdownReason = (typeof SHUTDOWN_SIGNALS)[number] | 'stdin-closed';

/**
 * Resolves on the first of: SIGINT, SIGTERM, or the client closing our standard input.
 *
 * The MCP stdio binding asks a server to exit promptly when its input is closed, which is
 * also how a client that crashed stops the servers it started.
 */
function waitForShutdown(): Promise<ShutdownReason> {
  return new Promise<ShutdownReason>((resolve) => {
    const signalHandlers = new Map<(typeof SHUTDOWN_SIGNALS)[number], () => void>();
    const onInputEnd = (): void => {
      finish('stdin-closed');
    };

    function finish(reason: ShutdownReason): void {
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
      process.stdin.off('end', onInputEnd);
      process.stdin.off('close', onInputEnd);
      resolve(reason);
    }

    for (const signal of SHUTDOWN_SIGNALS) {
      const handler = (): void => {
        finish(signal);
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    process.stdin.on('end', onInputEnd);
    process.stdin.on('close', onInputEnd);
  });
}

/**
 * Serves until a shutdown is requested, then returns the exit code.
 *
 * The engine is not closed here: its lifetime belongs to the caller, which closes it for
 * every command and for every outcome.
 */
export async function runServe(engine: Engine, logger: Logger, version: string): Promise<number> {
  // Listening for a stop is the very first thing done, before anything that takes time and
  // before a single byte is written. A stop asked for while the brokers are still connecting
  // must still be a graceful stop; and until this listener exists, a signal would terminate
  // the process by Node's default disposition, which is a race against our own start-up.
  const shutdown = waitForShutdown();

  // Brokers configured to connect at start-up connect now, so the first tool call does not
  // pay for it. A broker that refuses does not stop the server: the tools report it.
  await engine.start();

  // One factory, called once per connection: the tools are registered on whichever instance
  // the protocol era selects, over this one shared engine.
  const handle = serveStdio(() => createMcpServer(engine, { logger, version }), {
    onerror: (error) => {
      logger.warn('MCP transport error', { error: describeError(error) });
    },
  });
  logger.info('Serving MCP over stdio', { version });

  const reason = await shutdown;
  logger.info('Shutting down', { reason });
  await closeWithDeadline('mcp', handle.close(), logger);

  return EXIT_CODES.success;
}

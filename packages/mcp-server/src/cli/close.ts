/**
 * Bounded shutdown.
 *
 * A broker that stops acknowledging, or a transport whose pipe is already gone, must not
 * leave a process behind in an MCP client's process table. Each stage of the shutdown gets a
 * deadline; overrunning it is reported and then abandoned, because a server that cannot stop
 * is worse than one that stops untidily.
 */
import { describeError, type Logger } from '@kadeya/mqtt-intel-core';

export const CLOSE_TIMEOUT_MS = 5_000;

export async function closeWithDeadline(
  stage: string,
  close: Promise<void>,
  logger: Logger,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      close.then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          resolve('timeout');
        }, CLOSE_TIMEOUT_MS);
      }),
    ]);
    if (outcome === 'timeout') {
      logger.warn('Shutdown stage did not finish in time; giving up on it', {
        stage,
        timeoutMs: CLOSE_TIMEOUT_MS,
      });
    }
  } catch (error) {
    logger.warn('Shutdown stage failed', { stage, error: describeError(error) });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

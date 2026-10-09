/**
 * The `Clock` port.
 *
 * Nothing in the engine reads the wall clock or arms a timer directly. Rates, inactivity
 * detection, reconnection backoff, flush cycles and capture durations all depend on time, so
 * time is injected: tests drive it with `FakeClock` instead of sleeping.
 *
 * Two readings, because they answer different questions:
 * - `now()` is wall-clock time, the only thing comparable to a timestamp from elsewhere;
 * - `monotonic()` never jumps backwards, so it is what durations are measured with.
 */
import { OperationError } from './errors.js';

export interface Timer {
  /** Cancels the pending callback. Calling it twice is harmless. */
  cancel(): void;
}

export interface Clock {
  /** Milliseconds since the Unix epoch, subject to clock adjustments. */
  now(): number;
  /** Monotonic milliseconds, for measuring elapsed time. */
  monotonic(): number;
  /** Schedules `callback` after at least `delayMs`. */
  setTimeout(callback: () => void, delayMs: number): Timer;
  /** Resolves after `delayMs`, or rejects with `CANCELLED` if `signal` aborts first. */
  sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
}

/** Shared `sleep` so every clock cancels and rejects identically. */
export function sleepWithTimer(
  schedule: (callback: () => void, delayMs: number) => Timer,
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(new OperationError('CANCELLED', 'Sleep was cancelled before starting.'));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = schedule(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    function onAbort(): void {
      timer.cancel();
      reject(new OperationError('CANCELLED', 'Sleep was cancelled.'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  monotonic(): number {
    return performance.now();
  }

  setTimeout(callback: () => void, delayMs: number): Timer {
    const handle = globalThis.setTimeout(callback, delayMs);
    return {
      cancel(): void {
        globalThis.clearTimeout(handle);
      },
    };
  }

  sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    return sleepWithTimer((callback, delay) => this.setTimeout(callback, delay), delayMs, signal);
  }
}

/** The clock used unless a caller injects another one. */
export const systemClock: Clock = new SystemClock();

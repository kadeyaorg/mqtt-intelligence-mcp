/**
 * A `Clock` whose time only moves when a test says so.
 *
 * Every time-dependent behaviour in the engine — backoff, flush cycles, inactivity, capture
 * deadlines — is tested by advancing this clock, never by sleeping. Tests stay fast and
 * deterministic, and a slow CI machine cannot turn them flaky.
 */
import type { Clock, Timer } from '../domain/clock.js';
import { sleepWithTimer } from '../domain/clock.js';
import { ValidationError } from '../domain/errors.js';

export interface FakeClockOptions {
  /** Initial wall-clock reading. Defaults to 2026-01-01T00:00:00Z. */
  readonly now?: number;
  /** Initial monotonic reading. Defaults to 0. */
  readonly monotonic?: number;
}

const DEFAULT_NOW = Date.UTC(2026, 0, 1);

interface ScheduledTimer {
  readonly id: number;
  /** Monotonic time at which the callback is due. */
  readonly dueAt: number;
  readonly callback: () => void;
}

/** Lets `await`ed continuations run between two timer callbacks. */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export class FakeClock implements Clock {
  #wall: number;
  #monotonic: number;
  #nextId = 1;
  readonly #timers = new Map<number, ScheduledTimer>();

  constructor(options: FakeClockOptions = {}) {
    this.#wall = options.now ?? DEFAULT_NOW;
    this.#monotonic = options.monotonic ?? 0;
  }

  now(): number {
    return this.#wall;
  }

  monotonic(): number {
    return this.#monotonic;
  }

  setTimeout(callback: () => void, delayMs: number): Timer {
    if (!Number.isFinite(delayMs)) {
      throw new ValidationError('INVALID_ARGUMENT', 'Timer delay must be a finite number.');
    }
    const id = this.#nextId++;
    this.#timers.set(id, {
      id,
      dueAt: this.#monotonic + Math.max(0, delayMs),
      callback,
    });
    const timers = this.#timers;
    return {
      cancel(): void {
        timers.delete(id);
      },
    };
  }

  sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    return sleepWithTimer((callback, delay) => this.setTimeout(callback, delay), delayMs, signal);
  }

  /** Number of timers still waiting to fire. */
  get pendingTimerCount(): number {
    return this.#timers.size;
  }

  /**
   * Moves time forward by `durationMs`, firing every timer that becomes due, in order.
   *
   * Timers armed by a callback during the advance are honoured too, as long as they fall
   * within the same window, which is what makes re-arming loops (such as the ingest flush
   * cycle) testable.
   */
  async advance(durationMs: number): Promise<void> {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new ValidationError(
        'INVALID_ARGUMENT',
        'Advance duration must be a finite, non-negative number of milliseconds.',
      );
    }
    const target = this.#monotonic + durationMs;

    for (;;) {
      const next = this.#earliestTimer();
      if (next === undefined || next.dueAt > target) {
        break;
      }
      this.#setMonotonic(next.dueAt);
      this.#timers.delete(next.id);
      next.callback();
      await flushMicrotasks();
    }

    this.#setMonotonic(target);
    await flushMicrotasks();
  }

  /** Moves the wall clock without touching the monotonic reading, as an NTP step would. */
  setWallClock(now: number): void {
    if (!Number.isFinite(now)) {
      throw new ValidationError('INVALID_ARGUMENT', 'Wall-clock time must be a finite number.');
    }
    this.#wall = now;
  }

  #earliestTimer(): ScheduledTimer | undefined {
    let earliest: ScheduledTimer | undefined;
    for (const timer of this.#timers.values()) {
      // Ties fire in the order they were scheduled, like a real event loop.
      if (earliest === undefined || timer.dueAt < earliest.dueAt) {
        earliest = timer;
      }
    }
    return earliest;
  }

  #setMonotonic(value: number): void {
    const delta = value - this.#monotonic;
    this.#monotonic = value;
    this.#wall += delta;
  }
}

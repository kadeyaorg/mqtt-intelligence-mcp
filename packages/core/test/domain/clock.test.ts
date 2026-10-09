import { describe, expect, it } from 'vitest';
import { OperationError, SystemClock, systemClock, ValidationError } from '../../src/index.js';
import { FakeClock } from '../../src/testing/index.js';

describe('SystemClock', () => {
  it('reads the wall clock and a monotonic counter', () => {
    const clock = new SystemClock();
    const before = Date.now();

    expect(clock.now()).toBeGreaterThanOrEqual(before);
    expect(clock.monotonic()).toBeGreaterThan(0);
    expect(clock.monotonic()).toBeLessThanOrEqual(clock.monotonic());
  });

  it('fires a timer, and cancellation prevents it', async () => {
    const clock = new SystemClock();
    let fired = false;

    const cancelled = clock.setTimeout(() => {
      fired = true;
    }, 0);
    cancelled.cancel();
    await clock.sleep(5);

    expect(fired).toBe(false);
  });

  it('rejects a sleep when its signal aborts', async () => {
    const clock = new SystemClock();
    const controller = new AbortController();
    const pending = clock.sleep(10_000, controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('exports a shared default instance', () => {
    expect(systemClock.now()).toBeGreaterThan(0);
  });
});

describe('FakeClock', () => {
  it('starts at a fixed, documented instant', () => {
    const clock = new FakeClock();

    expect(clock.now()).toBe(Date.UTC(2026, 0, 1));
    expect(clock.monotonic()).toBe(0);
  });

  it('accepts an initial instant', () => {
    const clock = new FakeClock({ now: 1_700_000_000_000, monotonic: 42 });

    expect(clock.now()).toBe(1_700_000_000_000);
    expect(clock.monotonic()).toBe(42);
  });

  it('moves both readings by the same amount', async () => {
    const clock = new FakeClock();

    await clock.advance(1500);

    expect(clock.monotonic()).toBe(1500);
    expect(clock.now()).toBe(Date.UTC(2026, 0, 1) + 1500);
  });

  it('fires a timer only once its delay has elapsed', async () => {
    const clock = new FakeClock();
    const firedAt: number[] = [];
    clock.setTimeout(() => firedAt.push(clock.monotonic()), 100);

    await clock.advance(99);
    expect(firedAt).toEqual([]);

    await clock.advance(1);
    expect(firedAt).toEqual([100]);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('fires timers in chronological order, ties in scheduling order', async () => {
    const clock = new FakeClock();
    const order: string[] = [];
    clock.setTimeout(() => order.push('late'), 50);
    clock.setTimeout(() => order.push('first-of-the-tie'), 10);
    clock.setTimeout(() => order.push('second-of-the-tie'), 10);

    await clock.advance(100);

    expect(order).toEqual(['first-of-the-tie', 'second-of-the-tie', 'late']);
  });

  it('runs timers armed by a callback within the same advance', async () => {
    const clock = new FakeClock();
    const ticks: number[] = [];

    const rearm = (): void => {
      ticks.push(clock.monotonic());
      clock.setTimeout(rearm, 100);
    };
    clock.setTimeout(rearm, 100);

    await clock.advance(350);

    expect(ticks).toEqual([100, 200, 300]);
    expect(clock.pendingTimerCount).toBe(1);
  });

  it('cancels a timer, and tolerates cancelling twice', async () => {
    const clock = new FakeClock();
    let fired = false;
    const timer = clock.setTimeout(() => {
      fired = true;
    }, 10);

    timer.cancel();
    timer.cancel();
    await clock.advance(100);

    expect(fired).toBe(false);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('resolves a sleep when time passes', async () => {
    const clock = new FakeClock();
    let resolved = false;
    const pending = clock.sleep(200).then(() => {
      resolved = true;
    });

    await clock.advance(199);
    expect(resolved).toBe(false);

    await clock.advance(1);
    await pending;
    expect(resolved).toBe(true);
  });

  it('rejects a sleep whose signal aborts, and drops its timer', async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const pending = clock.sleep(1000, controller.signal);

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(OperationError);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('rejects a sleep whose signal is already aborted', async () => {
    const clock = new FakeClock();

    await expect(clock.sleep(1000, AbortSignal.abort())).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('steps the wall clock without disturbing durations, as an NTP correction would', async () => {
    const clock = new FakeClock();
    const startedAt = clock.monotonic();

    clock.setWallClock(Date.UTC(2020, 0, 1));
    await clock.advance(1000);

    expect(clock.monotonic() - startedAt).toBe(1000);
    expect(clock.now()).toBe(Date.UTC(2020, 0, 1) + 1000);
  });

  it.each([
    ['a negative duration', -1],
    ['a non-finite duration', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('refuses to advance by %s', async (_case, duration) => {
    const clock = new FakeClock();

    await expect(clock.advance(duration)).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a non-finite timer delay', () => {
    const clock = new FakeClock();

    expect(() => clock.setTimeout(() => undefined, Number.NaN)).toThrow(ValidationError);
  });

  it('treats a negative delay as due immediately', async () => {
    const clock = new FakeClock();
    let fired = false;
    clock.setTimeout(() => {
      fired = true;
    }, -5);

    await clock.advance(0);

    expect(fired).toBe(true);
  });
});

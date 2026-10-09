import { describe, expect, it, vi } from 'vitest';
import type { LogLevel } from '../../src/index.js';
import { createLogger, noopLogger, REDACTED, Secret } from '../../src/index.js';
import { createRecordingLogger, FakeClock } from '../../src/testing/index.js';

const PASSWORD = 'sup3r-s3cret';

function recorderAt(level: LogLevel = 'trace') {
  return createRecordingLogger({ level, clock: new FakeClock() });
}

describe('levels', () => {
  it('writes what the level allows and drops the rest', () => {
    const recorder = recorderAt('warn');

    recorder.logger.trace('t');
    recorder.logger.debug('d');
    recorder.logger.info('i');
    recorder.logger.warn('w');
    recorder.logger.error('e');

    expect(recorder.entries().map((entry) => entry['level'])).toEqual(['warn', 'error']);
  });

  it('answers isEnabled so a caller can skip expensive fields', () => {
    const recorder = recorderAt('info');

    expect(recorder.logger.isEnabled('debug')).toBe(false);
    expect(recorder.logger.isEnabled('info')).toBe(true);
    expect(recorder.logger.isEnabled('error')).toBe(true);
  });

  it('discards everything through the no-op logger', () => {
    expect(() => {
      noopLogger.trace('ignored');
      noopLogger.debug('ignored');
      noopLogger.info('ignored');
      noopLogger.warn('ignored');
      noopLogger.error('ignored', { broker: 'factory-fr' });
      noopLogger.child({ a: 1 }).info('ignored');
    }).not.toThrow();
    expect(noopLogger.isEnabled('error')).toBe(false);
    expect(noopLogger.child({})).toBe(noopLogger);
  });

  it('forgets the lines a recorder was told to clear', () => {
    const recorder = recorderAt();
    recorder.logger.info('first');

    recorder.clear();
    recorder.logger.info('second');

    expect(recorder.entries().map((entry) => entry['message'])).toEqual(['second']);
  });
});

describe('structure', () => {
  it('writes one JSON object per line, with time, level, message and fields', () => {
    const recorder = createRecordingLogger({ clock: new FakeClock({ now: Date.UTC(2026, 0, 2) }) });

    recorder.logger.info('connected', { broker: 'factory-fr', attempt: 2 });

    expect(recorder.entries()).toEqual([
      {
        time: '2026-01-02T00:00:00.000Z',
        level: 'info',
        message: 'connected',
        broker: 'factory-fr',
        attempt: 2,
      },
    ]);
  });

  it('repeats the fields bound to a child logger', () => {
    const recorder = recorderAt();
    const broker = recorder.logger.child({ broker: 'factory-fr' });

    broker.info('connected');
    broker.child({ filter: '#' }).info('subscribed', { grantedQos: 0 });
    recorder.logger.info('unrelated');

    const [first, second, third] = recorder.entries();
    expect(first).toMatchObject({ broker: 'factory-fr', message: 'connected' });
    expect(second).toMatchObject({ broker: 'factory-fr', filter: '#', grantedQos: 0 });
    expect(third).not.toHaveProperty('broker');
  });

  it('formats a readable line in pretty mode', () => {
    const recorder = createRecordingLogger({
      format: 'pretty',
      clock: new FakeClock({ now: Date.UTC(2026, 0, 2, 13, 45, 6, 789) }),
    });

    recorder.logger.warn('slow flush', { durationMs: 250, broker: 'factory-fr' });

    expect(recorder.lines[0]).toBe(
      '13:45:06.789 WARN  slow flush durationMs=250 broker=factory-fr',
    );
  });
});

describe('redaction', () => {
  it('replaces the value of a configured key, whatever it holds', () => {
    const recorder = createRecordingLogger({
      clock: new FakeClock(),
      redactKeys: ['password', 'apikey'],
    });

    recorder.logger.info('auth', {
      password: PASSWORD,
      ApiKey: 'abc123',
      nested: { password: { inner: PASSWORD } },
      username: 'supervision',
    });

    expect(recorder.text()).not.toContain(PASSWORD);
    expect(recorder.text()).not.toContain('abc123');
    expect(recorder.entries()[0]).toMatchObject({
      password: REDACTED,
      ApiKey: REDACTED,
      nested: { password: REDACTED },
      username: 'supervision',
    });
  });

  it('removes credentials from a URL, in a field and in the message', () => {
    const recorder = recorderAt();

    recorder.logger.error(`connect failed for mqtts://alice:${PASSWORD}@host:8883`, {
      url: `mqtts://alice:${PASSWORD}@host:8883`,
    });

    expect(recorder.text()).not.toContain(PASSWORD);
    expect(recorder.text()).toContain(REDACTED);
  });

  it('never writes a Secret, wherever it sits', () => {
    const recorder = recorderAt();

    recorder.logger.info('configured', {
      secret: new Secret(PASSWORD, 'env:MQTT_PASSWORD'),
      broker: { auth: { password: new Secret(PASSWORD, 'env:MQTT_PASSWORD') } },
      list: [new Secret(PASSWORD, 'env:MQTT_PASSWORD')],
    });

    expect(recorder.text()).not.toContain(PASSWORD);
    expect(recorder.entries()[0]).toMatchObject({
      secret: REDACTED,
      broker: { auth: { password: REDACTED } },
      list: [REDACTED],
    });
  });

  it('redacts in pretty mode too, which does not go through JSON.stringify', () => {
    const recorder = createRecordingLogger({
      format: 'pretty',
      clock: new FakeClock(),
      redactKeys: ['password'],
    });

    recorder.logger.info('configured', {
      secret: new Secret(PASSWORD, 'env:MQTT_PASSWORD'),
      password: PASSWORD,
      url: `mqtts://alice:${PASSWORD}@host:8883`,
    });

    expect(recorder.text()).not.toContain(PASSWORD);
    expect(recorder.lines[0]).toContain(`secret=${REDACTED}`);
  });

  it('summarizes an error without leaking what it quoted', () => {
    const recorder = recorderAt();
    const cause = new Error(`refused for mqtt://bob:${PASSWORD}@host`);
    const error = Object.assign(new Error('connection failed'), { code: 'ECONNREFUSED', cause });

    recorder.logger.error('broker unavailable', { error });

    const entry = recorder.entries()[0] as { error: Record<string, unknown> };
    expect(entry.error['name']).toBe('Error');
    expect(entry.error['message']).toBe('connection failed');
    expect(entry.error['code']).toBe('ECONNREFUSED');
    expect(recorder.text()).not.toContain(PASSWORD);
  });
});

describe('bounds', () => {
  it('never writes payload bytes, only their size', () => {
    const recorder = recorderAt();

    recorder.logger.info('message', { payload: new TextEncoder().encode('secret telemetry') });

    expect(recorder.text()).not.toContain('secret telemetry');
    expect(recorder.entries()[0]?.['payload']).toBe('[Uint8Array 16 bytes]');
  });

  it('truncates a long string instead of flooding the line', () => {
    const recorder = recorderAt();

    recorder.logger.info('big', { text: 'x'.repeat(10_000) });

    const text = recorder.entries()[0]?.['text'];
    expect(typeof text === 'string' && text.length).toBeLessThan(2200);
    expect(text).toContain('10000 characters');
  });

  it('survives a self-referencing object', () => {
    const recorder = recorderAt();
    const loop: Record<string, unknown> = { name: 'loop' };
    loop['self'] = loop;

    recorder.logger.info('cycle', { loop });

    expect(recorder.entries()[0]).toMatchObject({ loop: { name: 'loop', self: '[Circular]' } });
  });

  it('bounds depth, array length and key count', () => {
    const recorder = recorderAt();

    recorder.logger.info('bounded', {
      deep: { a: { b: { c: { d: { e: { f: 'too deep' } } } } } },
      many: Array.from({ length: 100 }, (_item, index) => index),
    });

    const entry = recorder.entries()[0];
    expect(recorder.text()).not.toContain('too deep');
    expect(JSON.stringify(entry)).toContain('[Max depth reached]');
    expect(JSON.stringify(entry)).toContain('more item(s)');
  });

  it('truncates a line that is still too long', () => {
    const recorder = createRecordingLogger({ clock: new FakeClock(), maxLineLength: 200 });

    recorder.logger.info(
      'big',
      Object.fromEntries(Array.from({ length: 50 }, (_x, i) => [`k${String(i)}`, 'value'])),
    );

    expect(recorder.lines[0]?.length).toBeLessThanOrEqual(212);
    expect(recorder.lines[0]).toContain('[truncated]');
  });
});

describe('robustness', () => {
  it('still writes a line, and does not throw, when a field misbehaves', () => {
    const recorder = recorderAt();
    const hostile = {
      get boom(): string {
        throw new Error('getter exploded');
      },
    };

    expect(() => {
      recorder.logger.info('ingest flush', { hostile });
    }).not.toThrow();

    expect(recorder.entries()[0]).toMatchObject({
      level: 'info',
      message: 'log entry could not be formatted',
      loggingError: 'getter exploded',
    });
  });
});

describe('destination', () => {
  it('writes to stderr and never to stdout', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      const logger = createLogger({ level: 'trace', clock: new FakeClock() });
      logger.info('to stderr', { broker: 'factory-fr' });
      logger.child({ a: 1 }).error('also stderr');

      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledTimes(2);
      expect(String(stderr.mock.calls[0]?.[0])).toMatch(/^\{.*\}\n$/u);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

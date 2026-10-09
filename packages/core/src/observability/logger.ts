/**
 * The `Logger` port and its default implementation (ADR-0015).
 *
 * Logs go to **stderr**, always: in stdio mode stdout carries MCP protocol frames, and a
 * single stray line there corrupts the session. The default implementation writes one JSON
 * object per line, which is what a log collector wants; `pretty` exists for a developer
 * reading a terminal.
 *
 * Fields are sanitized before they are written, so a secret, a device payload or a
 * self-referencing object cannot leak into a log line or break the logger.
 */
import type { Clock } from '../domain/clock.js';
import { systemClock } from '../domain/clock.js';
import { describeError } from '../domain/errors.js';
import type { LogFields, SafeRecord, SafeValue } from './fields.js';
import { sanitizeFields } from './fields.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export type LogFormat = 'json' | 'pretty';

/** Receives one formatted line, without its trailing newline. */
export type LogSink = (line: string) => void;

export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that repeats these fields on every line, for example a broker id. */
  child(fields: LogFields): Logger;
  /** Lets a caller skip building expensive fields that would be discarded. */
  isEnabled(level: LogLevel): boolean;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly format?: LogFormat;
  /** Defaults to writing to stderr. */
  readonly sink?: LogSink;
  readonly clock?: Clock;
  /** Field names whose values are replaced, compared case-insensitively. */
  readonly redactKeys?: Iterable<string>;
  /** Fields repeated on every line. */
  readonly fields?: LogFields;
  readonly maxLineLength?: number;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const DEFAULT_MAX_LINE_LENGTH = 16 * 1024;

function writeToStandardError(line: string): void {
  process.stderr.write(`${line}\n`);
}

interface LoggerContext {
  readonly level: LogLevel;
  readonly format: LogFormat;
  readonly sink: LogSink;
  readonly clock: Clock;
  readonly redactKeys: ReadonlySet<string>;
  readonly maxLineLength: number;
}

function formatTime(epochMs: number, format: LogFormat): string {
  const date = new Date(epochMs);
  const iso = date.toISOString();
  // "12:34:56.789" is enough on a terminal; a collector wants the full timestamp.
  return format === 'json' ? iso : iso.slice(11, 23);
}

function renderPrettyValue(value: SafeValue): string {
  if (typeof value === 'string') {
    return /[\s="]/.test(value) ? JSON.stringify(value) : value;
  }
  return JSON.stringify(value);
}

class StructuredLogger implements Logger {
  readonly #context: LoggerContext;
  readonly #fields: LogFields;

  constructor(context: LoggerContext, fields: LogFields) {
    this.#context = context;
    this.#fields = fields;
  }

  isEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.#context.level];
  }

  child(fields: LogFields): Logger {
    return new StructuredLogger(this.#context, { ...this.#fields, ...fields });
  }

  trace(message: string, fields?: LogFields): void {
    this.#write('trace', message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.#write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.#write('error', message, fields);
  }

  #write(level: LogLevel, message: string, fields: LogFields | undefined): void {
    if (!this.isEnabled(level)) {
      return;
    }
    const context = this.#context;
    const time = formatTime(context.clock.now(), context.format);

    let line: string;
    try {
      const merged = fields === undefined ? this.#fields : { ...this.#fields, ...fields };
      const safe = sanitizeFields(merged, { redactKeys: context.redactKeys });
      const safeMessage = sanitizeMessage(message, context.redactKeys);
      line =
        context.format === 'json'
          ? renderJson(time, level, safeMessage, safe)
          : renderPretty(time, level, safeMessage, safe);
    } catch (error) {
      // A field can misbehave: a getter that throws, an exotic proxy. Logging is never worth
      // breaking the caller, so the entry degrades to its message plus the reason.
      line = renderJson(time, level, 'log entry could not be formatted', {
        loggingError: describeError(error),
      });
    }

    context.sink(truncateLine(line, context.maxLineLength));
  }
}

function sanitizeMessage(message: string, redactKeys: ReadonlySet<string>): string {
  const sanitized = sanitizeFields({ message }, { redactKeys, maxStringLength: 4096 });
  const value: SafeValue | undefined = sanitized['message'];
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

function renderJson(time: string, level: LogLevel, message: string, fields: SafeRecord): string {
  const entry = {
    time,
    level,
    message,
    ...fields,
  };
  try {
    return JSON.stringify(entry);
  } catch {
    // Sanitization makes this unreachable, but a logger must never throw at its caller.
    return JSON.stringify({ time, level, message, fieldsError: 'not serializable' });
  }
}

function renderPretty(time: string, level: LogLevel, message: string, fields: SafeRecord): string {
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${renderPrettyValue(value)}`)
    .join(' ');
  const head = `${time} ${level.toUpperCase().padEnd(5)} ${message}`;
  return rendered === '' ? head : `${head} ${rendered}`;
}

function truncateLine(line: string, maxLength: number): string {
  return line.length <= maxLength ? line : `${line.slice(0, maxLength)}…[truncated]`;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const context: LoggerContext = {
    level: options.level ?? 'info',
    format: options.format ?? 'json',
    sink: options.sink ?? writeToStandardError,
    clock: options.clock ?? systemClock,
    redactKeys: new Set([...(options.redactKeys ?? [])].map((key) => key.toLowerCase())),
    maxLineLength: options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH,
  };
  return new StructuredLogger(context, options.fields ?? {});
}

/** Discards everything. The default when a library user injects nothing. */
export const noopLogger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
  isEnabled: () => false,
};

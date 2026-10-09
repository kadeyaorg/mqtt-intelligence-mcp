/**
 * A logger that keeps what it was asked to write, so a test can assert on it.
 *
 * It runs the real formatting and sanitization: assertions are made against the exact line a
 * collector would receive, which is the only way to prove a secret never reaches one.
 */
import type { LogFields, LogLevel, Logger, LoggerOptions } from '../observability/index.js';
import { createLogger } from '../observability/index.js';

export interface RecordedLine {
  readonly level: LogLevel;
  readonly line: string;
}

export interface RecordingLogger {
  readonly logger: Logger;
  /** Every line written, in order. */
  readonly lines: readonly string[];
  /** The lines parsed as JSON. Only meaningful with the default `json` format. */
  entries(): readonly Record<string, unknown>[];
  /** Everything written, joined, for "must not contain" assertions. */
  text(): string;
  clear(): void;
}

/**
 * @param options forwarded to the real logger, except `sink`, which is this recorder.
 */
export function createRecordingLogger(options: Omit<LoggerOptions, 'sink'> = {}): RecordingLogger {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'trace',
    ...options,
    sink: (line) => {
      lines.push(line);
    },
  });

  return {
    logger,
    lines,
    entries(): readonly Record<string, unknown>[] {
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    text(): string {
      return lines.join('\n');
    },
    clear(): void {
      lines.length = 0;
    },
  };
}

export type { LogFields, LogLevel, Logger };

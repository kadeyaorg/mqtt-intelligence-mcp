/**
 * Turns arbitrary log fields into values that are safe, bounded and serializable.
 *
 * Logs are written from the ingest path and from error handlers, where the values at hand
 * are whatever MQTT and third-party libraries produced: device payloads, connection errors
 * quoting a URL, binary buffers, objects that reference themselves. Three things must never
 * happen: a secret reaching a log line, an unbounded value flooding it, and `JSON.stringify`
 * throwing inside the logger.
 *
 * So every field goes through here first (ADR-0015).
 */
import { describeError, redactCredentials, REDACTED } from '../domain/errors.js';
import { Secret } from '../domain/secret.js';

export type LogFieldValue = unknown;
export type LogFields = Readonly<Record<string, LogFieldValue>>;

/** A value that is safe to serialize: no secrets, no cycles, bounded in size. */
export type SafeRecord = Readonly<Record<string, SafeValue>>;

export type SafeValue =
  string | number | boolean | null | readonly SafeValue[] | { readonly [key: string]: SafeValue };

export interface SanitizeOptions {
  /** Lowercase keys whose values are replaced, whatever they contain. */
  readonly redactKeys?: ReadonlySet<string>;
  readonly maxDepth?: number;
  readonly maxStringLength?: number;
  readonly maxArrayLength?: number;
  readonly maxKeys?: number;
}

const DEFAULTS = {
  maxDepth: 6,
  maxStringLength: 2048,
  maxArrayLength: 64,
  maxKeys: 64,
} as const;

interface Budget {
  readonly redactKeys: ReadonlySet<string>;
  readonly maxDepth: number;
  readonly maxStringLength: number;
  readonly maxArrayLength: number;
  readonly maxKeys: number;
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}… (${String(value.length)} characters)`;
}

function sanitizeError(error: Error, budget: Budget, seen: Set<object>, depth: number): SafeValue {
  const result: Record<string, SafeValue> = {
    name: error.name,
    message: describeError(error),
  };
  if ('code' in error && (typeof error.code === 'string' || typeof error.code === 'number')) {
    result['code'] = error.code;
  }
  if (error.cause !== undefined && depth < budget.maxDepth) {
    result['cause'] = sanitizeValue(error.cause, budget, seen, depth + 1);
  }
  return result;
}

function sanitizeValue(
  value: unknown,
  budget: Budget,
  seen: Set<object>,
  depth: number,
): SafeValue {
  if (value === null || value === undefined) {
    return null;
  }
  switch (typeof value) {
    case 'string':
      return truncateString(redactCredentials(value), budget.maxStringLength);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return `${value.toString()}n`;
    case 'function':
      return '[Function]';
    case 'symbol':
      return value.toString();
    case 'object':
    case 'undefined':
      break;
  }

  if (value instanceof Secret) {
    return REDACTED;
  }
  if (value instanceof Error) {
    return sanitizeError(value, budget, seen, depth);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (ArrayBuffer.isView(value)) {
    // Never the content: a payload may hold personal data, and a key is a secret.
    return `[${value.constructor.name} ${String(value.byteLength)} bytes]`;
  }
  if (value instanceof URL) {
    return redactCredentials(value.toString());
  }

  const container: object = value;
  if (seen.has(container)) {
    return '[Circular]';
  }
  if (depth >= budget.maxDepth) {
    return '[Max depth reached]';
  }
  seen.add(container);
  try {
    if (Array.isArray(value)) {
      const visible = value.slice(0, budget.maxArrayLength);
      const items = visible.map((item) => sanitizeValue(item, budget, seen, depth + 1));
      return value.length > visible.length
        ? [...items, `… ${String(value.length - visible.length)} more item(s)`]
        : items;
    }
    if (value instanceof Map) {
      return sanitizeEntries([...value.entries()], budget, seen, depth);
    }
    if (value instanceof Set) {
      return sanitizeValue([...value], budget, seen, depth);
    }
    return sanitizeEntries(Object.entries(container), budget, seen, depth);
  } finally {
    seen.delete(container);
  }
}

function sanitizeEntries(
  entries: readonly (readonly [unknown, unknown])[],
  budget: Budget,
  seen: Set<object>,
  depth: number,
): SafeRecord {
  const result: Record<string, SafeValue> = {};
  let written = 0;
  for (const [key, entryValue] of entries) {
    if (written >= budget.maxKeys) {
      result['…'] = `${String(entries.length - written)} more key(s)`;
      break;
    }
    const name = typeof key === 'string' ? key : String(key);
    result[name] = budget.redactKeys.has(name.toLowerCase())
      ? REDACTED
      : sanitizeValue(entryValue, budget, seen, depth + 1);
    written += 1;
  }
  return result;
}

/** Sanitizes a set of log fields, redacting by key name and by content. */
export function sanitizeFields(fields: LogFields, options: SanitizeOptions = {}): SafeRecord {
  const budget: Budget = {
    redactKeys: options.redactKeys ?? new Set<string>(),
    maxDepth: options.maxDepth ?? DEFAULTS.maxDepth,
    maxStringLength: options.maxStringLength ?? DEFAULTS.maxStringLength,
    maxArrayLength: options.maxArrayLength ?? DEFAULTS.maxArrayLength,
    maxKeys: options.maxKeys ?? DEFAULTS.maxKeys,
  };
  return sanitizeEntries(Object.entries(fields), budget, new Set<object>(), 0);
}

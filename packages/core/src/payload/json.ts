/**
 * Bounding and redacting a parsed JSON payload before an agent sees it.
 *
 * A payload is device data: it can be far deeper, wider and longer than anything useful in a
 * model's context, and it can carry credentials a provisioning topic publishes in clear. So
 * the value is rebuilt within explicit limits, with configured keys replaced, and the caller
 * is told whether anything was cut.
 */
import { REDACTED } from '../domain/errors.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface JsonLimits {
  readonly maxDepth: number;
  readonly maxKeys: number;
  readonly maxArrayLength: number;
  readonly maxStringLength: number;
}

export const DEFAULT_JSON_LIMITS: JsonLimits = {
  maxDepth: 8,
  maxKeys: 64,
  maxArrayLength: 64,
  maxStringLength: 512,
};

export interface LimitJsonOptions {
  readonly limits?: Partial<JsonLimits>;
  /** Lowercase key names whose values are replaced. */
  readonly redactKeys?: ReadonlySet<string>;
}

export interface LimitedJson {
  readonly value: JsonValue;
  /** True when depth, width or length limits cut something out. */
  readonly truncated: boolean;
  /** How many values were replaced because of their key name. */
  readonly redactedKeys: number;
}

const DEPTH_MARKER = '[truncated: maximum depth reached]';

interface Walk {
  readonly limits: JsonLimits;
  readonly redactKeys: ReadonlySet<string>;
  truncated: boolean;
  redactedKeys: number;
}

function limitString(value: string, walk: Walk): string {
  if (value.length <= walk.limits.maxStringLength) {
    return value;
  }
  walk.truncated = true;
  return `${value.slice(0, walk.limits.maxStringLength)}… (${String(value.length)} characters)`;
}

function walkValue(value: unknown, walk: Walk, depth: number): JsonValue {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case 'string':
      return limitString(value, walk);
    case 'number':
      // JSON.parse yields finite numbers only, but a value may still be enormous.
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    // JSON.parse never produces the rest; objects and arrays are handled below.
    case 'object':
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      break;
  }

  if (depth >= walk.limits.maxDepth) {
    walk.truncated = true;
    return DEPTH_MARKER;
  }

  if (Array.isArray(value)) {
    const kept = value.slice(0, walk.limits.maxArrayLength);
    if (kept.length < value.length) {
      walk.truncated = true;
    }
    return kept.map((item) => walkValue(item, walk, depth + 1));
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const kept = entries.slice(0, walk.limits.maxKeys);
  if (kept.length < entries.length) {
    walk.truncated = true;
  }
  // Object.fromEntries defines properties, so a payload key named __proto__ stays a key
  // instead of reaching the prototype.
  return Object.fromEntries(
    kept.map(([key, entryValue]) => {
      if (walk.redactKeys.has(key.toLowerCase())) {
        walk.redactedKeys += 1;
        return [key, REDACTED];
      }
      return [key, walkValue(entryValue, walk, depth + 1)];
    }),
  );
}

export function limitJson(value: unknown, options: LimitJsonOptions = {}): LimitedJson {
  const walk: Walk = {
    limits: { ...DEFAULT_JSON_LIMITS, ...options.limits },
    redactKeys: options.redactKeys ?? new Set<string>(),
    truncated: false,
    redactedKeys: 0,
  };
  const limited = walkValue(value, walk, 0);
  return { value: limited, truncated: walk.truncated, redactedKeys: walk.redactedKeys };
}

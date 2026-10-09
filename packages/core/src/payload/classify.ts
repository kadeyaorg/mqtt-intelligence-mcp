/**
 * What a payload is, decided from its bytes alone (ADR-0010).
 *
 * MQTT carries bytes. A topic may publish JSON today, a bare number tomorrow, and protobuf
 * from a different device on the same tree. Guessing from the topic name, or trusting the
 * MQTT 5 `contentType` a device claims, would be wrong often enough to matter, so
 * classification reads the bytes and nothing else.
 *
 * The order below is fixed and documented, because overlapping cases exist: `42` is both a
 * JSON document and a number, and `true` is both JSON and a boolean. The most specific
 * answer wins, since that is the one an engineer means.
 */

export type PayloadKind = 'empty' | 'json' | 'number' | 'boolean' | 'text' | 'binary' | 'unknown';

export type JsonType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

/** Why a payload was not inspected. Only set for `unknown`. */
export type UninspectedReason = 'oversized' | 'not-inspected' | 'budget-exhausted';

export interface PayloadClassification {
  readonly kind: PayloadKind;
  /** Set for `json`: what the top-level value is. */
  readonly jsonType?: JsonType;
  readonly reason?: UninspectedReason;
}

export interface ClassifyOptions {
  /** Payloads above this size are never parsed. Defaults to 256 KiB. */
  readonly maxInspectBytes?: number;
}

export const DEFAULT_MAX_INSPECT_BYTES = 256 * 1024;

/** Share of control characters above which text is treated as binary. */
const CONTROL_CHARACTER_RATIO = 0.05;

/** JSON number grammar: no leading `+`, no leading zero, no hexadecimal. */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Decodes strictly: invalid UTF-8 means the payload is not text. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

function isControlCharacter(code: number): boolean {
  // Tab, newline and carriage return are ordinary in text payloads.
  if (code === 0x09 || code === 0x0a || code === 0x0d) {
    return false;
  }
  return code < 0x20 || code === 0x7f;
}

/** Binary formats that decode as UTF-8 by accident still carry control characters. */
export function looksBinary(text: string): boolean {
  if (text.includes('\u0000')) {
    return true;
  }
  let controls = 0;
  for (const character of text) {
    if (isControlCharacter(character.codePointAt(0) ?? 0)) {
      controls += 1;
    }
  }
  return controls > 0 && controls / text.length > CONTROL_CHARACTER_RATIO;
}

function jsonTypeOf(value: unknown): JsonType {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  const type = typeof value;
  if (type === 'object' || type === 'string' || type === 'number' || type === 'boolean') {
    return type;
  }
  /* v8 ignore next -- JSON.parse cannot produce anything else */
  return 'string';
}

/**
 * Classifies a payload from its bytes.
 *
 * Order: empty, then oversized, then invalid UTF-8 or control-heavy bytes as binary, then
 * boolean, then number, then JSON (a document starting with `{`, `[` or `"`), then text.
 */
export function classifyPayload(
  bytes: Uint8Array,
  options: ClassifyOptions = {},
): PayloadClassification {
  if (bytes.byteLength === 0) {
    return { kind: 'empty' };
  }
  const maxInspectBytes = options.maxInspectBytes ?? DEFAULT_MAX_INSPECT_BYTES;
  if (bytes.byteLength > maxInspectBytes) {
    return { kind: 'unknown', reason: 'oversized' };
  }

  const text = decodeUtf8(bytes);
  if (text === undefined || looksBinary(text)) {
    return { kind: 'binary' };
  }

  const trimmed = text.trim();
  if (trimmed === 'true' || trimmed === 'false') {
    return { kind: 'boolean' };
  }
  if (JSON_NUMBER.test(trimmed) && Number.isFinite(Number(trimmed))) {
    return { kind: 'number' };
  }

  const first = trimmed[0];
  if (first === '{' || first === '[' || first === '"') {
    try {
      return { kind: 'json', jsonType: jsonTypeOf(JSON.parse(trimmed)) };
    } catch {
      // A truncated or malformed document is still text an engineer can read.
      return { kind: 'text' };
    }
  }
  return { kind: 'text' };
}

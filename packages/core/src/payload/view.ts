/**
 * The only way payload content leaves the engine (ADR-0010).
 *
 * Whatever a device published, what an agent receives is typed, bounded, escaped and
 * redacted. Binary is never dumped: a hash and a short hex preview say what it is without
 * spending context on bytes a model cannot read, and without shipping data that may be
 * personal.
 *
 * Payload content is untrusted data. Nothing here interprets it, and callers must not treat
 * it as instructions.
 */
import { createHash } from 'node:crypto';
import type { PayloadClassification, UninspectedReason } from './classify.js';
import { classifyPayload, decodeUtf8 } from './classify.js';
import type { JsonLimits, JsonValue } from './json.js';
import { limitJson } from './json.js';

export type PayloadView =
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'json';
      readonly value: JsonValue;
      readonly truncated: boolean;
      readonly redactedKeys: number;
    }
  | { readonly kind: 'number'; readonly value: number; readonly raw?: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'text'; readonly text: string; readonly truncated: boolean }
  | {
      readonly kind: 'binary';
      readonly size: number;
      readonly hexPreview: string;
      /** Absent when the stored bytes are a prefix: it would not identify the payload. */
      readonly sha256?: string;
      readonly truncated: boolean;
    }
  | { readonly kind: 'unknown'; readonly size: number; readonly reason: UninspectedReason };

export interface PayloadViewOptions {
  /** Reuses a classification computed at ingest instead of redoing the work. */
  readonly classification?: PayloadClassification;
  readonly maxInspectBytes?: number;
  /** Size as published, when `bytes` is a prefix kept for storage. */
  readonly originalSize?: number;
  /** True when `bytes` is a prefix of the published payload. */
  readonly truncated?: boolean;
  readonly maxTextChars?: number;
  readonly jsonLimits?: Partial<JsonLimits>;
  /** Key names whose values are replaced, compared case-insensitively. */
  readonly redactKeys?: Iterable<string>;
  readonly hexPreviewBytes?: number;
}

export const DEFAULT_MAX_TEXT_CHARS = 2000;
export const DEFAULT_HEX_PREVIEW_BYTES = 32;

/** Escapes what a terminal or a model should not receive raw, keeping tabs and newlines. */
export function escapeControlCharacters(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return text.replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

function toHexPreview(bytes: Uint8Array, previewBytes: number): string {
  const visible = bytes.subarray(0, previewBytes);
  const hex = [...visible].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
  return bytes.byteLength > visible.byteLength ? `${hex} …` : hex;
}

function toTextView(text: string, maxChars: number, alreadyTruncated: boolean): PayloadView {
  const escaped = escapeControlCharacters(text);
  if (escaped.length <= maxChars) {
    return { kind: 'text', text: escaped, truncated: alreadyTruncated };
  }
  return {
    kind: 'text',
    text: `${escaped.slice(0, maxChars)}… (${String(escaped.length)} characters)`,
    truncated: true,
  };
}

/**
 * Builds the view of a payload.
 *
 * `bytes` may be a prefix of what was published, because storage bounds payloads: pass
 * `truncated` and `originalSize` so the view reports the real size and does not claim a hash
 * of something it only partly holds.
 */
export function toPayloadView(bytes: Uint8Array, options: PayloadViewOptions = {}): PayloadView {
  const truncated = options.truncated ?? false;
  const size = options.originalSize ?? bytes.byteLength;
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const classification =
    options.classification ??
    classifyPayload(bytes, {
      ...(options.maxInspectBytes === undefined
        ? {}
        : { maxInspectBytes: options.maxInspectBytes }),
    });

  const previewBytes = options.hexPreviewBytes ?? DEFAULT_HEX_PREVIEW_BYTES;

  if (classification.kind === 'empty') {
    return { kind: 'empty' };
  }
  if (classification.kind === 'unknown') {
    return { kind: 'unknown', size, reason: classification.reason ?? 'not-inspected' };
  }
  if (classification.kind === 'binary') {
    return {
      kind: 'binary',
      size,
      hexPreview: toHexPreview(bytes, previewBytes),
      truncated,
      ...(truncated ? {} : { sha256: createHash('sha256').update(bytes).digest('hex') }),
    };
  }

  const text = decodeUtf8(bytes);
  if (text === undefined) {
    // The bytes changed since classification, or a prefix cut a character in half.
    return { kind: 'binary', size, hexPreview: toHexPreview(bytes, previewBytes), truncated };
  }
  const trimmed = text.trim();

  if (classification.kind === 'boolean') {
    return { kind: 'boolean', value: trimmed === 'true' };
  }

  if (classification.kind === 'number') {
    const value = Number(trimmed);
    // A 20-digit integer does not survive a double; say so rather than lie quietly.
    return String(value) === trimmed
      ? { kind: 'number', value }
      : { kind: 'number', value, raw: trimmed };
  }

  if (classification.kind === 'json') {
    try {
      const limited = limitJson(JSON.parse(trimmed), {
        ...(options.jsonLimits === undefined ? {} : { limits: options.jsonLimits }),
        redactKeys: new Set([...(options.redactKeys ?? [])].map((key) => key.toLowerCase())),
      });
      return {
        kind: 'json',
        value: limited.value,
        truncated: limited.truncated || truncated,
        redactedKeys: limited.redactedKeys,
      };
    } catch {
      // A stored prefix of a JSON document no longer parses: show it as the text it is.
      return toTextView(text, maxTextChars, true);
    }
  }

  return toTextView(text, maxTextChars, truncated);
}

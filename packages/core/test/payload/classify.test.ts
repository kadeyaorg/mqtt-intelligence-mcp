import { describe, expect, it } from 'vitest';
import type { PayloadKind } from '../../src/index.js';
import { classifyPayload } from '../../src/index.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function kindOf(input: string | Uint8Array): PayloadKind {
  return classifyPayload(typeof input === 'string' ? utf8(input) : input).kind;
}

describe('classification', () => {
  it.each([
    ['an empty payload', '', 'empty'],
    ['a JSON object', '{"ready":true}', 'json'],
    ['a JSON array', '[1,2,3]', 'json'],
    ['a JSON string', '"hello"', 'json'],
    ['a JSON object with whitespace around it', '  \n {"a":1} \n ', 'json'],
    ['a bare number, which is more specific than JSON', '42', 'number'],
    ['a negative decimal', '-12.5', 'number'],
    ['a number in scientific notation', '1.5e-3', 'number'],
    ['a boolean, which is more specific than JSON', 'true', 'boolean'],
    ['false', 'false', 'boolean'],
    ['plain text', 'RUNNING', 'text'],
    ['text that mentions JSON without being JSON', 'status: {ok}', 'text'],
    ['a malformed JSON document, still readable as text', '{"ready":', 'text'],
    ['a bare null, which is not treated as a JSON document', 'null', 'text'],
    ['text with a trailing newline', 'RUNNING\n', 'text'],
    ['multi-line text', 'line one\nline two', 'text'],
    ['a leading-zero number, which JSON forbids', '007', 'text'],
    ['a hexadecimal literal, which JSON forbids', '0x1f', 'text'],
    ['an ISO timestamp', '2026-01-02T03:04:05Z', 'text'],
    ['non-ASCII text', 'température: 21,5 °C', 'text'],
    ['an emoji, which is a surrogate pair', '🤖', 'text'],
  ])('classifies %s as %s', (_case, payload, expected) => {
    expect(kindOf(payload)).toBe(expected);
  });

  it.each([
    ['invalid UTF-8', new Uint8Array([0xff, 0xfe, 0xfd])],
    ['a truncated multi-byte character', new Uint8Array([0xe2, 0x82])],
    ['a null byte inside text', utf8('ready\u0000false')],
    ['protobuf-like bytes', new Uint8Array([0x08, 0x96, 0x01, 0x12, 0x03, 0x61, 0x62, 0x63])],
    ['a run of control characters', new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05])],
  ])('classifies %s as binary', (_case, bytes) => {
    expect(kindOf(bytes)).toBe('binary');
  });

  it('tolerates a rare control character inside otherwise readable text', () => {
    expect(kindOf(`${'a'.repeat(200)}\u0001`)).toBe('text');
  });

  it('reports a JSON payload with its top-level type', () => {
    expect(classifyPayload(utf8('{"a":1}'))).toEqual({ kind: 'json', jsonType: 'object' });
    expect(classifyPayload(utf8('[1]'))).toEqual({ kind: 'json', jsonType: 'array' });
    expect(classifyPayload(utf8('"text"'))).toEqual({ kind: 'json', jsonType: 'string' });
  });

  it('does not inspect a payload larger than the limit', () => {
    const large = new Uint8Array(1024);

    expect(classifyPayload(large, { maxInspectBytes: 512 })).toEqual({
      kind: 'unknown',
      reason: 'oversized',
    });
    expect(classifyPayload(large, { maxInspectBytes: 2048 }).kind).toBe('binary');
  });

  it('classifies a 10 MB blob without parsing it', () => {
    const blob = new Uint8Array(10 * 1024 * 1024).fill(0x7b);

    const started = performance.now();
    const classification = classifyPayload(blob);

    expect(classification).toEqual({ kind: 'unknown', reason: 'oversized' });
    expect(performance.now() - started).toBeLessThan(100);
  });

  it.each([
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['an empty-ish payload of spaces', '   '],
  ])('treats %s as text, since JSON has no such number', (_case, payload) => {
    expect(kindOf(payload)).toBe('text');
  });

  it('strips a byte order mark so a BOM-prefixed document still reads as JSON', () => {
    expect(kindOf('﻿{"a":1}')).toBe('json');
  });
});

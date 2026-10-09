import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REDACTED, toPayloadView } from '../../src/index.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('simple values', () => {
  it('renders an empty payload', () => {
    expect(toPayloadView(new Uint8Array())).toEqual({ kind: 'empty' });
  });

  it.each([
    ['true', true],
    ['false', false],
    [' true\n', true],
  ])('renders the boolean %s', (payload, expected) => {
    expect(toPayloadView(utf8(payload))).toEqual({ kind: 'boolean', value: expected });
  });

  it('renders a number', () => {
    expect(toPayloadView(utf8('21.5'))).toEqual({ kind: 'number', value: 21.5 });
  });

  it('keeps the raw text when a number does not survive a double', () => {
    expect(toPayloadView(utf8('12345678901234567890'))).toEqual({
      kind: 'number',
      value: Number('12345678901234567890'),
      raw: '12345678901234567890',
    });
  });
});

describe('text', () => {
  it('escapes control characters, keeping newlines and tabs readable', () => {
    const view = toPayloadView(utf8('alarm\u0007 raised\nline\ttwo'));

    expect(view).toEqual({
      kind: 'text',
      text: 'alarm\\u0007 raised\nline\ttwo',
      truncated: false,
    });
  });

  it('truncates long text and says how long it was', () => {
    const view = toPayloadView(utf8('x'.repeat(5000)), { maxTextChars: 100 });

    expect(view.kind).toBe('text');
    if (view.kind === 'text') {
      expect(view.truncated).toBe(true);
      expect(view.text).toContain('(5000 characters)');
      expect(view.text.length).toBeLessThan(140);
    }
  });
});

describe('json', () => {
  it('renders a document and reports that nothing was cut', () => {
    const view = toPayloadView(utf8('{"ready":true,"position":{"x":12.4,"y":8.1}}'));

    expect(view).toEqual({
      kind: 'json',
      value: { ready: true, position: { x: 12.4, y: 8.1 } },
      truncated: false,
      redactedKeys: 0,
    });
  });

  it('replaces configured keys at any depth and counts them', () => {
    const view = toPayloadView(
      utf8('{"user":"a","Password":"p1","device":{"token":"t1","id":7}}'),
      { redactKeys: ['password', 'token'] },
    );

    expect(JSON.stringify(view)).not.toContain('p1');
    expect(JSON.stringify(view)).not.toContain('t1');
    expect(view).toEqual({
      kind: 'json',
      value: { user: 'a', Password: REDACTED, device: { token: REDACTED, id: 7 } },
      truncated: false,
      redactedKeys: 2,
    });
  });

  it('bounds depth, width and string length, and flags the truncation', () => {
    const deep = JSON.stringify({ a: { b: { c: { d: { e: 'too deep' } } } } });

    const view = toPayloadView(utf8(deep), { jsonLimits: { maxDepth: 3 } });

    expect(JSON.stringify(view)).not.toContain('too deep');
    expect(JSON.stringify(view)).toContain('maximum depth');
    expect(view.kind === 'json' && view.truncated).toBe(true);
  });

  it('bounds a wide object and a long array', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 500 }, (_item, index) => [`k${String(index)}`, index]),
    );
    const view = toPayloadView(utf8(JSON.stringify({ wide, items: Array(500).fill(1) })), {
      jsonLimits: { maxKeys: 5, maxArrayLength: 3 },
    });

    expect(view.kind).toBe('json');
    if (view.kind === 'json') {
      const value = view.value as { wide: Record<string, number>; items: number[] };
      expect(Object.keys(value.wide)).toHaveLength(5);
      expect(value.items).toEqual([1, 1, 1]);
      expect(view.truncated).toBe(true);
    }
  });

  it('survives a thousand levels of nesting without exploding', () => {
    let nested = '1';
    for (let level = 0; level < 1000; level += 1) {
      nested = `{"a":${nested}}`;
    }

    const view = toPayloadView(utf8(nested));

    expect(view.kind).toBe('json');
    expect(JSON.stringify(view).length).toBeLessThan(500);
  });

  it('keeps a payload key named __proto__ as a key, not a prototype', () => {
    const view = toPayloadView(utf8('{"__proto__":{"polluted":true},"ok":1}'));

    expect(view.kind).toBe('json');
    if (view.kind === 'json') {
      const value = view.value as Record<string, unknown>;
      expect(Object.keys(value)).toEqual(['__proto__', 'ok']);
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('bounds a very long string inside a document', () => {
    const view = toPayloadView(utf8(JSON.stringify({ blob: 'y'.repeat(10_000) })), {
      jsonLimits: { maxStringLength: 32 },
    });

    expect(JSON.stringify(view).length).toBeLessThan(200);
    expect(view.kind === 'json' && view.truncated).toBe(true);
  });
});

describe('binary', () => {
  it('reports size, hash and a short hex preview, never the content', () => {
    const bytes = new Uint8Array([0x08, 0x96, 0x01, 0x12, 0x03, 0x61, 0x62, 0x63]);

    const view = toPayloadView(bytes, { hexPreviewBytes: 4 });

    expect(view).toEqual({
      kind: 'binary',
      size: 8,
      hexPreview: '08 96 01 12 …',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      truncated: false,
    });
  });

  it('omits the hash when it only holds a prefix, since it would identify nothing', () => {
    const view = toPayloadView(new Uint8Array([0x01, 0x02]), {
      truncated: true,
      originalSize: 4096,
    });

    expect(view).toEqual({
      kind: 'binary',
      size: 4096,
      hexPreview: '01 02',
      truncated: true,
    });
  });
});

describe('payloads kept only in part', () => {
  it('reports the published size, not the stored size', () => {
    const view = toPayloadView(utf8('RUNNING'), { truncated: true, originalSize: 9000 });

    expect(view).toEqual({ kind: 'text', text: 'RUNNING', truncated: true });
  });

  it('falls back to text when a stored prefix no longer parses as JSON', () => {
    const view = toPayloadView(utf8('{"ready":tr'), {
      classification: { kind: 'json', jsonType: 'object' },
      truncated: true,
      originalSize: 2048,
    });

    expect(view).toEqual({ kind: 'text', text: '{"ready":tr', truncated: true });
  });

  it('falls back to binary when a prefix cut a character in half', () => {
    const view = toPayloadView(new Uint8Array([0xe2, 0x82]), {
      classification: { kind: 'text' },
      truncated: true,
      originalSize: 3,
    });

    expect(view).toMatchObject({ kind: 'binary', size: 3, truncated: true });
  });
});

describe('payloads that were not inspected', () => {
  it('reports size and reason for an oversized payload', () => {
    const view = toPayloadView(new Uint8Array(4096), { maxInspectBytes: 1024 });

    expect(view).toEqual({ kind: 'unknown', size: 4096, reason: 'oversized' });
  });

  it('reports a payload skipped by the ingest sampler', () => {
    const view = toPayloadView(utf8('{"a":1}'), {
      classification: { kind: 'unknown', reason: 'not-inspected' },
    });

    expect(view).toEqual({ kind: 'unknown', size: 7, reason: 'not-inspected' });
  });
});

describe('bounds', () => {
  it.each([
    ['a huge JSON document', utf8(JSON.stringify({ items: Array(50_000).fill('abcdefghij') }))],
    ['a huge text payload', utf8('x'.repeat(200_000))],
    ['a huge binary payload', new Uint8Array(200_000).fill(0x01)],
  ])('keeps the rendered view small for %s', (_case, bytes) => {
    const view = toPayloadView(bytes, { maxInspectBytes: 1024 * 1024 });

    expect(JSON.stringify(view).length).toBeLessThan(4096);
  });
});

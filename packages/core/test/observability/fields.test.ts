/**
 * The field sanitizer is what stands between a log line and whatever MQTT, Node and
 * third-party libraries hand us. These cases are the ones that would otherwise make the
 * logger throw, or make it write something it should not.
 */
import { describe, expect, it } from 'vitest';
import { REDACTED, sanitizeFields, Secret } from '../../src/index.js';

describe('sanitizeFields', () => {
  it.each([
    ['a string', { value: 'plain' }, { value: 'plain' }],
    ['a number', { value: 42 }, { value: 42 }],
    ['a boolean', { value: false }, { value: false }],
    ['null', { value: null }, { value: null }],
    ['undefined', { value: undefined }, { value: null }],
    ['NaN, which JSON cannot encode', { value: Number.NaN }, { value: 'NaN' }],
    ['Infinity', { value: Number.POSITIVE_INFINITY }, { value: 'Infinity' }],
    ['a bigint, which JSON.stringify would throw on', { value: 10n }, { value: '10n' }],
    ['a function', { value: () => 1 }, { value: '[Function]' }],
    ['a symbol', { value: Symbol('tag') }, { value: 'Symbol(tag)' }],
    ['a nested object', { value: { a: { b: 1 } } }, { value: { a: { b: 1 } } }],
    ['an array', { value: [1, 'two', true] }, { value: [1, 'two', true] }],
  ])('handles %s', (_case, fields, expected) => {
    expect(sanitizeFields(fields)).toEqual(expected);
  });

  it('renders a date as an instant, and an invalid one as such', () => {
    expect(sanitizeFields({ at: new Date(Date.UTC(2026, 0, 2)) })).toEqual({
      at: '2026-01-02T00:00:00.000Z',
    });
    expect(sanitizeFields({ at: new Date(Number.NaN) })).toEqual({ at: 'Invalid Date' });
  });

  it('flattens maps and sets', () => {
    expect(
      sanitizeFields({
        counts: new Map([
          ['a', 1],
          ['b', 2],
        ]),
        filters: new Set(['#', 'a/#']),
      }),
    ).toEqual({ counts: { a: 1, b: 2 }, filters: ['#', 'a/#'] });
  });

  it('redacts credentials inside a URL object', () => {
    const sanitized = sanitizeFields({ url: new URL('mqtts://alice:pw@host:8883/path') });

    expect(JSON.stringify(sanitized)).not.toContain('pw');
    expect(JSON.stringify(sanitized)).toContain(REDACTED);
  });

  it('reports binary size rather than content', () => {
    expect(sanitizeFields({ payload: new Uint8Array([1, 2, 3]) })).toEqual({
      payload: '[Uint8Array 3 bytes]',
    });
    expect(sanitizeFields({ view: new DataView(new ArrayBuffer(8)) })).toEqual({
      view: '[DataView 8 bytes]',
    });
  });

  it('redacts a Secret and any key on the redaction list, at any depth', () => {
    const sanitized = sanitizeFields(
      {
        token: 'abc',
        nested: { TOKEN: 'abc', items: [{ token: 'abc' }] },
        secret: new Secret('abc', 'env:X'),
      },
      { redactKeys: new Set(['token']) },
    );

    expect(JSON.stringify(sanitized)).not.toContain('abc');
    expect(sanitized).toEqual({
      token: REDACTED,
      nested: { TOKEN: REDACTED, items: [{ token: REDACTED }] },
      secret: REDACTED,
    });
  });

  it('bounds the number of keys it writes', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 10 }, (_item, index) => [`k${String(index)}`, index]),
    );

    const sanitized = sanitizeFields({ wide }, { maxKeys: 3 });

    expect(sanitized['wide']).toEqual({ k0: 0, k1: 1, k2: 2, '…': '7 more key(s)' });
  });

  it('bounds array length and string length', () => {
    const sanitized = sanitizeFields(
      { items: [1, 2, 3, 4, 5], text: 'abcdefgh' },
      { maxArrayLength: 2, maxStringLength: 4 },
    );

    expect(sanitized['items']).toEqual([1, 2, '… 3 more item(s)']);
    expect(sanitized['text']).toBe('abcd… (8 characters)');
  });

  it('stops at the configured depth', () => {
    const sanitized = sanitizeFields({ a: { b: { c: { d: 'deep' } } } }, { maxDepth: 2 });

    expect(JSON.stringify(sanitized)).not.toContain('deep');
    expect(JSON.stringify(sanitized)).toContain('[Max depth reached]');
  });

  it('handles a cycle through an array', () => {
    const items: unknown[] = [1];
    items.push(items);

    expect(sanitizeFields({ items })).toEqual({ items: [1, '[Circular]'] });
  });

  it('keeps the same object twice when it is not a cycle', () => {
    const shared = { id: 1 };

    expect(sanitizeFields({ left: shared, right: shared })).toEqual({
      left: { id: 1 },
      right: { id: 1 },
    });
  });

  it('produces something JSON.stringify always accepts', () => {
    const awkward = {
      big: 2n,
      fn: () => 1,
      sym: Symbol('x'),
      bytes: new Uint8Array(2),
      nan: Number.NaN,
      map: new Map<unknown, unknown>([[{ key: 'object' }, 'value']]),
    };

    expect(() => JSON.stringify(sanitizeFields(awkward))).not.toThrow();
  });
});

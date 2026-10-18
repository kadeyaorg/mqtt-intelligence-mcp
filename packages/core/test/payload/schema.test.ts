/**
 * Inferring a payload's shape from the payloads themselves.
 *
 * Two properties carry the weight here. The schema must be **mergeable**, because ingestion
 * batches and could one day be sharded, so the same payloads in any grouping must give the
 * same answer. And it must be **bounded**, because a topic keyed by device id would otherwise
 * grow a field per device for ever.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { JsonValue, SchemaNode } from '../../src/index.js';
import {
  DEFAULT_SCHEMA_LIMITS,
  EMPTY_SCHEMA,
  mergeSchemas,
  observeJson,
  toJsonSchema,
} from '../../src/index.js';

function infer(values: readonly JsonValue[], limits = DEFAULT_SCHEMA_LIMITS): SchemaNode {
  let node: SchemaNode | undefined;
  for (const value of values) {
    node = observeJson(node, value, limits);
  }
  return node ?? EMPTY_SCHEMA;
}

describe('inferring a shape', () => {
  it('records the types it saw and how often', () => {
    const node = infer([1, 2, 'three']);

    expect(node.seen).toBe(3);
    expect(node.types).toMatchObject({ number: 2, string: 1, boolean: 0 });
  });

  it('describes an object field by field', () => {
    const node = infer([
      { state: 'READY', cycleCount: 12 },
      { state: 'STOPPED', cycleCount: 13 },
    ]);

    expect(node.fields?.['state']?.types.string).toBe(2);
    expect(node.fields?.['cycleCount']?.types.number).toBe(2);
  });

  it('counts a field that is sometimes absent, which is what makes it optional', () => {
    const node = infer([{ code: 42, message: 'over torque' }, { code: 0 }, { code: 7 }]);

    expect(node.types.object).toBe(3);
    expect(node.fields?.['code']?.seen).toBe(3);
    // Two fewer than the objects: the schema export turns this into "not required".
    expect(node.fields?.['message']?.seen).toBe(1);
  });

  it('keeps every type a field has taken, rather than the last one', () => {
    const node = infer([{ value: 1 }, { value: 'n/a' }, { value: null }]);

    expect(node.fields?.['value']?.types).toMatchObject({ number: 1, string: 1, null: 1 });
  });

  it('merges every element of every array into one element shape', () => {
    const node = infer([{ points: [1, 2, 3] }, { points: [4, 'five'] }]);

    expect(node.fields?.['points']?.types.array).toBe(2);
    expect(node.fields?.['points']?.items?.types).toMatchObject({ number: 4, string: 1 });
  });
});

describe('bounds', () => {
  it('treats an object with too many distinct keys as a map', () => {
    const limits = { ...DEFAULT_SCHEMA_LIMITS, maxFields: 4 };
    // A payload keyed by device id: the keys are data, not a record's field names.
    const node = infer(
      [
        { 'device-1': { ok: true }, 'device-2': { ok: false } },
        { 'device-3': { ok: true }, 'device-4': { ok: true }, 'device-5': { ok: false } },
      ],
      limits,
    );

    expect(node.fields).toBeUndefined();
    expect(node.mapKeys).toBeGreaterThanOrEqual(5);
    expect(node.mapValues?.fields?.['ok']?.types.boolean).toBe(5);
  });

  it('stops at the depth limit and says so instead of pretending', () => {
    const limits = { ...DEFAULT_SCHEMA_LIMITS, maxDepth: 2 };

    const node = infer([{ a: { b: { c: { d: 1 } } } }], limits);

    expect(node.fields?.['a']?.fields?.['b']?.truncated).toBe(true);
    expect(JSON.stringify(toJsonSchema(node, limits))).toContain('Inference stopped here');
  });

  it('stops growing at the node budget rather than following a topic that never repeats a key', () => {
    const limits = { ...DEFAULT_SCHEMA_LIMITS, maxFields: 1000, maxNodes: 20 };
    const payloads = Array.from({ length: 50 }, (_, index) => ({
      [`field${String(index)}`]: index,
    }));

    const node = infer(payloads, limits);

    expect(node.truncated).toBe(true);
    expect(Object.keys(node.fields ?? {}).length).toBeLessThanOrEqual(20);
  });
});

describe('merging', () => {
  it('gives the same schema however the payloads are split into batches', () => {
    const payloadArbitrary = fc.letrec<{ value: JsonValue }>((tie) => ({
      value: fc.oneof(
        { depthSize: 'small' },
        fc.constant(null),
        fc.boolean(),
        fc.integer(),
        fc.string(),
        fc.array(tie('value'), { maxLength: 3 }),
        fc.dictionary(fc.constantFrom('a', 'b', 'c', 'd'), tie('value'), { maxKeys: 4 }),
      ),
    })).value;

    fc.assert(
      fc.property(
        fc.array(payloadArbitrary, { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 20 }),
        (payloads, cut) => {
          const split = Math.min(cut, payloads.length);
          const whole = infer(payloads);
          const left = payloads.slice(0, split);
          const right = payloads.slice(split);

          const merged =
            left.length === 0
              ? infer(right)
              : right.length === 0
                ? infer(left)
                : mergeSchemas(infer(left), infer(right));

          expect(merged).toEqual(whole);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('folds keys once either side has folded them, whichever order the merge happens in', () => {
    const limits = { ...DEFAULT_SCHEMA_LIMITS, maxFields: 2 };
    const wide = infer([{ a: 1, b: 2, c: 3 }], limits);
    const narrow = infer([{ a: 4 }], limits);

    const left = mergeSchemas(wide, narrow, limits);
    const right = mergeSchemas(narrow, wide, limits);

    expect(left).toEqual(right);
    expect(left.mapValues?.types.number).toBe(4);
  });
});

describe('exporting JSON Schema', () => {
  it('marks a field seen in every object as required, and the others not', () => {
    const node = infer([{ code: 42, message: 'over torque' }, { code: 0 }]);

    const schema = toJsonSchema(node) as Record<string, unknown>;

    expect(schema['type']).toBe('object');
    expect(schema['required']).toEqual(['code']);
    expect(Object.keys(schema['properties'] as object)).toEqual(['code', 'message']);
  });

  it('exports a union when a position held more than one type', () => {
    const schema = toJsonSchema(infer([1, 'two', null])) as Record<string, unknown>;

    expect(schema['type']).toEqual(['null', 'number', 'string']);
  });

  it('says plainly when nothing was observed', () => {
    const schema = toJsonSchema(EMPTY_SCHEMA);

    expect(JSON.stringify(schema)).toContain('No payload was observed');
  });

  it('describes a map through additionalProperties, naming how many keys it folded', () => {
    const limits = { ...DEFAULT_SCHEMA_LIMITS, maxFields: 2 };
    const node = infer([{ a: 1, b: 2, c: 3 }], limits);

    const schema = toJsonSchema(node, limits) as Record<string, unknown>;

    expect(schema['additionalProperties']).toMatchObject({ type: 'number' });
    expect(String(schema['description'])).toContain('Keys vary');
  });
});

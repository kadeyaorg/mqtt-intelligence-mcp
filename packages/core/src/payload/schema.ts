/**
 * What shape do this topic's payloads have?
 *
 * MQTT carries no schema, so the only way to answer is to watch. This accumulates a picture
 * of a topic's JSON structure across many payloads, and it is built around three constraints
 * that come from the rest of the engine rather than from JSON Schema.
 *
 * **Mergeable.** A schema is counts, not flags: how many values were seen at a position, and
 * how many of each type. Two schemas of the same topic merge by adding, so an ingest batch,
 * two workers, or a database aggregating server-side all produce the same answer (ADR-0008).
 * Optionality falls out of the counts — a field seen in 40 of 100 objects is optional — which
 * means it needs no separate bookkeeping and cannot disagree with itself.
 *
 * **Bounded.** An object with more distinct keys than `maxFields` is almost never a record
 * with many fields; it is a map keyed by an id. Collapsing it into a single value shape is
 * both more accurate and what keeps a schema from growing with the traffic (ADR-0009).
 *
 * **Honest.** Where a limit stopped inference, the node says so, and the exported schema says
 * so, rather than presenting a partial shape as the whole one (ADR-0011).
 */
import type { JsonObject, JsonValue } from './json.js';

export interface SchemaTypeCounts {
  readonly null: number;
  readonly boolean: number;
  readonly number: number;
  readonly string: number;
  readonly array: number;
  readonly object: number;
}

const NO_TYPES: SchemaTypeCounts = {
  null: 0,
  boolean: 0,
  number: 0,
  string: 0,
  array: 0,
  object: 0,
};

export type SchemaTypeName = keyof SchemaTypeCounts;

export interface SchemaNode {
  /** Values observed at this position, of any type. */
  readonly seen: number;
  readonly types: SchemaTypeCounts;
  /** Shape of each named field, when objects here have few enough distinct keys. */
  readonly fields?: Readonly<Record<string, SchemaNode>>;
  /** Shape of the values, when the keys vary too much to be fields. */
  readonly mapValues?: SchemaNode;
  /** Distinct keys folded into `mapValues`, which is a floor rather than a total. */
  readonly mapKeys?: number;
  /** Shape of array elements, merged across every array seen here. */
  readonly items?: SchemaNode;
  /** A limit stopped inference at this position. */
  readonly truncated?: boolean;
}

export interface SchemaLimits {
  /** Below this, nesting is described; at it, a node is marked truncated. */
  readonly maxDepth: number;
  /** An object with more distinct keys than this is treated as a map. */
  readonly maxFields: number;
  /** Safety valve: once this many nodes exist, no new field is added. */
  readonly maxNodes: number;
}

export const DEFAULT_SCHEMA_LIMITS: SchemaLimits = {
  maxDepth: 6,
  maxFields: 32,
  maxNodes: 512,
};

/** A position nothing has been observed at yet. */
export const EMPTY_SCHEMA: SchemaNode = { seen: 0, types: NO_TYPES };

function addTypes(left: SchemaTypeCounts, right: SchemaTypeCounts): SchemaTypeCounts {
  return {
    null: left.null + right.null,
    boolean: left.boolean + right.boolean,
    number: left.number + right.number,
    string: left.string + right.string,
    array: left.array + right.array,
    object: left.object + right.object,
  };
}

function typeOf(value: JsonValue): SchemaTypeName {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  const kind = typeof value;
  return kind === 'boolean' || kind === 'number' || kind === 'string' ? kind : 'object';
}

/** Nodes in a subtree, so the safety valve can be checked before growing one. */
export function countNodes(node: SchemaNode | undefined): number {
  if (node === undefined) {
    return 0;
  }
  let total = 1;
  for (const field of Object.values(node.fields ?? {})) {
    total += countNodes(field);
  }
  total += countNodes(node.mapValues);
  total += countNodes(node.items);
  return total;
}

/** Folds every named field into one shape, which is what a map node holds. */
function foldFields(node: SchemaNode): { values: SchemaNode | undefined; keys: number } {
  let values = node.mapValues;
  let keys = node.mapKeys ?? 0;
  for (const field of Object.values(node.fields ?? {})) {
    values = values === undefined ? field : mergeSchemas(values, field);
    keys += 1;
  }
  return { values, keys };
}

/** Turns an object node into a map node. Folding is commutative, so it may happen at any time. */
function asMap(node: SchemaNode): SchemaNode {
  const { values, keys } = foldFields(node);
  return {
    seen: node.seen,
    types: node.types,
    ...(values === undefined ? {} : { mapValues: values }),
    mapKeys: keys,
    ...(node.items === undefined ? {} : { items: node.items }),
    ...(node.truncated === true ? { truncated: true } : {}),
  };
}

/**
 * Merges two schemas of the same position.
 *
 * Commutative and associative, which is what lets batches be split and recombined freely.
 */
export function mergeSchemas(
  left: SchemaNode,
  right: SchemaNode,
  limits: SchemaLimits = DEFAULT_SCHEMA_LIMITS,
): SchemaNode {
  // A map on either side wins: once keys have been folded, they cannot be unfolded, and
  // folding the other side gives the same result whichever order the merge happened in.
  if (left.mapValues !== undefined || right.mapValues !== undefined) {
    const a = asMap(left);
    const b = asMap(right);
    const values =
      a.mapValues === undefined
        ? b.mapValues
        : b.mapValues === undefined
          ? a.mapValues
          : mergeSchemas(a.mapValues, b.mapValues, limits);
    return {
      seen: a.seen + b.seen,
      types: addTypes(a.types, b.types),
      ...(values === undefined ? {} : { mapValues: values }),
      mapKeys: (a.mapKeys ?? 0) + (b.mapKeys ?? 0),
      ...mergedItems(a, b, limits),
      ...(a.truncated === true || b.truncated === true ? { truncated: true } : {}),
    };
  }

  const names = new Set([...Object.keys(left.fields ?? {}), ...Object.keys(right.fields ?? {})]);
  if (names.size > limits.maxFields) {
    return mergeSchemas(asMap(left), asMap(right), limits);
  }

  const fields: Record<string, SchemaNode> = {};
  for (const name of names) {
    const a = left.fields?.[name];
    const b = right.fields?.[name];
    fields[name] =
      a === undefined ? (b ?? EMPTY_SCHEMA) : b === undefined ? a : mergeSchemas(a, b, limits);
  }

  return {
    seen: left.seen + right.seen,
    types: addTypes(left.types, right.types),
    ...(names.size === 0 ? {} : { fields }),
    ...mergedItems(left, right, limits),
    ...(left.truncated === true || right.truncated === true ? { truncated: true } : {}),
  };
}

function mergedItems(
  left: SchemaNode,
  right: SchemaNode,
  limits: SchemaLimits,
): { items?: SchemaNode } {
  if (left.items === undefined) {
    return right.items === undefined ? {} : { items: right.items };
  }
  if (right.items === undefined) {
    return { items: left.items };
  }
  return { items: mergeSchemas(left.items, right.items, limits) };
}

/**
 * Folds one payload into a schema.
 *
 * The node budget is a safety valve, not a precise rule: a topic whose payloads never repeat
 * a key would otherwise grow without bound. When it is hit, new fields stop being added and
 * the node is marked truncated, so which fields a pathological topic ends up describing can
 * depend on the order its payloads arrived. Everything within the limits merges exactly.
 */
export function observeJson(
  node: SchemaNode | undefined,
  value: JsonValue,
  limits: SchemaLimits = DEFAULT_SCHEMA_LIMITS,
  depth = 0,
): SchemaNode {
  const current = node ?? EMPTY_SCHEMA;
  const type = typeOf(value);
  const base: SchemaNode = {
    seen: current.seen + 1,
    types: addTypes(current.types, { ...NO_TYPES, [type]: 1 }),
    ...(current.fields === undefined ? {} : { fields: current.fields }),
    ...(current.mapValues === undefined ? {} : { mapValues: current.mapValues }),
    ...(current.mapKeys === undefined ? {} : { mapKeys: current.mapKeys }),
    ...(current.items === undefined ? {} : { items: current.items }),
    ...(current.truncated === true ? { truncated: true } : {}),
  };

  if (depth >= limits.maxDepth && (type === 'object' || type === 'array')) {
    return { ...base, truncated: true };
  }

  if (type === 'array') {
    let items = current.items;
    for (const element of value as JsonValue[]) {
      items = observeJson(items, element, limits, depth + 1);
    }
    return { ...base, ...(items === undefined ? {} : { items }) };
  }

  if (type !== 'object') {
    return base;
  }

  const entries = Object.entries(value as JsonObject);

  // Already a map, or about to become one: fold rather than remember every key.
  const distinct = new Set([...Object.keys(current.fields ?? {}), ...entries.map(([key]) => key)]);
  if (current.mapValues !== undefined || distinct.size > limits.maxFields) {
    const folded = asMap(base);
    let values = folded.mapValues;
    for (const [, child] of entries) {
      values = observeJson(values, child, limits, depth + 1);
    }
    return {
      ...folded,
      ...(values === undefined ? {} : { mapValues: values }),
      mapKeys: Math.max(folded.mapKeys ?? 0, distinct.size),
    };
  }

  const budgetLeft = limits.maxNodes - countNodes(current);
  const fields: Record<string, SchemaNode> = { ...current.fields };
  let added = 0;
  let truncated = current.truncated === true;
  for (const [key, child] of entries) {
    const existing = fields[key];
    if (existing === undefined && added >= budgetLeft) {
      truncated = true;
      continue;
    }
    if (existing === undefined) {
      added += 1;
    }
    fields[key] = observeJson(existing, child, limits, depth + 1);
  }

  return {
    ...base,
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Types actually observed at a position, in a stable order. */
export function observedTypes(node: SchemaNode): readonly SchemaTypeName[] {
  const order: readonly SchemaTypeName[] = [
    'null',
    'boolean',
    'number',
    'string',
    'array',
    'object',
  ];
  return order.filter((name) => node.types[name] > 0);
}

/**
 * Exports a JSON Schema (draft 2020-12).
 *
 * It carries what was inferred and the counts behind it, because a schema inferred from
 * observation is a summary of what was seen and not a contract anyone promised. A field
 * missing from `required` means it was absent from some payloads, not that it is optional by
 * design, and the description says so.
 */
export function toJsonSchema(
  node: SchemaNode,
  limits: SchemaLimits = DEFAULT_SCHEMA_LIMITS,
): JsonValue {
  const types = observedTypes(node);
  if (types.length === 0) {
    return { description: 'No payload was observed.' };
  }

  const schema: JsonObject = {
    type: types.length === 1 ? (types[0] as string) : types.map((name) => name),
  };

  if (node.types.object > 0) {
    if (node.mapValues !== undefined) {
      schema['additionalProperties'] = toJsonSchema(node.mapValues, limits);
      schema['description'] =
        `Keys vary, so the ${String(node.mapKeys ?? 0)} seen were summarised as one value shape.`;
    } else if (node.fields !== undefined) {
      const properties: JsonObject = {};
      const required: string[] = [];
      for (const [name, field] of Object.entries(node.fields)) {
        properties[name] = toJsonSchema(field, limits);
        if (field.seen === node.types.object) {
          required.push(name);
        }
      }
      schema['properties'] = properties;
      if (required.length > 0) {
        schema['required'] = required.sort();
      }
    }
  }

  if (node.types.array > 0 && node.items !== undefined) {
    schema['items'] = toJsonSchema(node.items, limits);
  }

  if (node.truncated === true) {
    schema['$comment'] =
      `Inference stopped here at a limit (depth ${String(limits.maxDepth)}, ${String(limits.maxFields)} fields): the real payload may hold more.`;
  }

  return schema;
}

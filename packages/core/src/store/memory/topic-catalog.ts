/**
 * The in-memory topic catalog (ADR-0008).
 *
 * Bounded by construction: a hard per-broker topic limit, and a documented policy when it is
 * reached. Namespaces with device identifiers in the topic path reach hundreds of thousands
 * of topics, so "it will be fine" is not a plan — what matters is that the limit is explicit
 * and that hitting it is **reported**, since a listing missing half a namespace is worse than
 * one that says it is incomplete.
 */
import type { BrokerId } from '../../domain/ids.js';
import type { TopicName } from '../../domain/topic.js';
import { matchesTopic } from '../../domain/topic.js';
import type {
  CatalogBatchResult,
  CatalogStats,
  Page,
  TopicCatalog,
  TopicQuery,
  TopicSortKey,
  TopicTreeNode,
  TreeQuery,
} from '../../catalog/index.js';
import type { TopicDelta, TopicRecord } from '../../catalog/index.js';
import { applyDelta, createRecord, decayRate } from '../../catalog/index.js';

export interface MemoryTopicCatalogOptions {
  readonly maxTopicsPerBroker?: number;
  /** What to do when the limit is reached. */
  readonly onTopicLimit?: 'evict-lru' | 'ignore-new';
  readonly rateTimeConstantMs?: number;
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
}

const DEFAULTS = {
  maxTopicsPerBroker: 50_000,
  onTopicLimit: 'evict-lru' as const,
  defaultLimit: 100,
  maxLimit: 1000,
};

interface BrokerCatalog {
  /** Insertion order is kept by Map, and refreshed on update to serve as LRU order. */
  readonly records: Map<TopicName, TopicRecord>;
  evictedTopics: number;
  ignoredTopics: number;
}

interface Cursor {
  readonly key: string | number;
  readonly topic: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): Cursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'key' in parsed && 'topic' in parsed) {
      const candidate = parsed;
      if (
        (typeof candidate.key === 'string' || typeof candidate.key === 'number') &&
        typeof candidate.topic === 'string'
      ) {
        return { key: candidate.key, topic: candidate.topic };
      }
    }
  } catch {
    // An unreadable cursor is treated as no cursor: the caller simply starts again.
  }
  return undefined;
}

function sortValue(record: TopicRecord, key: TopicSortKey, now: number): string | number {
  switch (key) {
    case 'topic':
      return record.topic;
    case 'lastSeenAt':
      return record.lastSeenAt;
    case 'messageCount':
      return record.messageCount;
    case 'rate':
      // Comparing undecayed rates would rank a topic that stopped an hour ago too high.
      return decayRate(record.rate, now).perSecond;
  }
}

function compare(left: string | number, right: string | number): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  return String(left).localeCompare(String(right));
}

export class MemoryTopicCatalog implements TopicCatalog {
  readonly #brokers = new Map<BrokerId, BrokerCatalog>();
  readonly #options: Required<MemoryTopicCatalogOptions>;

  constructor(options: MemoryTopicCatalogOptions = {}) {
    this.#options = {
      maxTopicsPerBroker: options.maxTopicsPerBroker ?? DEFAULTS.maxTopicsPerBroker,
      onTopicLimit: options.onTopicLimit ?? DEFAULTS.onTopicLimit,
      rateTimeConstantMs: options.rateTimeConstantMs ?? 60_000,
      defaultLimit: options.defaultLimit ?? DEFAULTS.defaultLimit,
      maxLimit: options.maxLimit ?? DEFAULTS.maxLimit,
    };
  }

  applyBatch(brokerId: BrokerId, deltas: readonly TopicDelta[]): Promise<CatalogBatchResult> {
    const catalog = this.#catalogOf(brokerId);
    let applied = 0;
    let evicted = 0;
    let ignored = 0;

    for (const delta of deltas) {
      const existing = catalog.records.get(delta.topic);
      if (existing !== undefined) {
        catalog.records.delete(delta.topic);
        catalog.records.set(delta.topic, applyDelta(existing, delta));
        applied += 1;
        continue;
      }

      if (catalog.records.size >= this.#options.maxTopicsPerBroker) {
        if (this.#options.onTopicLimit === 'ignore-new') {
          catalog.ignoredTopics += 1;
          ignored += 1;
          continue;
        }
        const oldest = catalog.records.keys().next();
        if (!oldest.done) {
          catalog.records.delete(oldest.value);
          catalog.evictedTopics += 1;
          evicted += 1;
        }
      }

      catalog.records.set(
        delta.topic,
        createRecord(brokerId, delta, this.#options.rateTimeConstantMs),
      );
      applied += 1;
    }

    return Promise.resolve({ applied, evicted, ignored });
  }

  get(brokerId: BrokerId, topic: TopicName): Promise<TopicRecord | undefined> {
    return Promise.resolve(this.#brokers.get(brokerId)?.records.get(topic));
  }

  query(query: TopicQuery): Promise<Page<TopicRecord>> {
    const now = Date.now();
    const sortBy = query.sortBy ?? 'topic';
    const limit = Math.min(query.limit ?? this.#options.defaultLimit, this.#options.maxLimit);

    const matching = this.#allRecords(query.brokerId).filter((record) =>
      this.#matches(record, query),
    );

    const direction = query.descending === true ? -1 : 1;
    matching.sort((left, right) => {
      const byKey =
        compare(sortValue(left, sortBy, now), sortValue(right, sortBy, now)) * direction;
      // Topic breaks ties, so a cursor always resumes at a single, unambiguous place.
      return byKey !== 0 ? byKey : left.topic.localeCompare(right.topic);
    });

    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const start =
      cursor === undefined
        ? 0
        : matching.findIndex((record) => {
            const byKey = compare(sortValue(record, sortBy, now), cursor.key) * direction;
            return byKey > 0 || (byKey === 0 && record.topic.localeCompare(cursor.topic) > 0);
          });

    const items = start < 0 ? [] : matching.slice(start, start + limit);
    const last = items.at(-1);
    const hasMore = start >= 0 && start + items.length < matching.length;

    return Promise.resolve({
      items,
      ...(hasMore && last !== undefined
        ? { nextCursor: encodeCursor({ key: sortValue(last, sortBy, now), topic: last.topic }) }
        : {}),
    });
  }

  tree(query: TreeQuery): Promise<TopicTreeNode> {
    const root = query.root ?? [];
    const depth = query.depth ?? 3;
    const maxChildren = query.maxChildren ?? 50;
    const records = this.#allRecords(query.brokerId).filter((record) =>
      startsWithLevels(record.topic, root),
    );

    return Promise.resolve(
      buildNode(root, records, depth, maxChildren, query.foldPatterns ?? true),
    );
  }

  stats(brokerId: BrokerId): Promise<CatalogStats> {
    const catalog = this.#brokers.get(brokerId);
    const records = catalog === undefined ? [] : [...catalog.records.values()];
    return Promise.resolve({
      brokerId,
      topicCount: records.length,
      messageCount: records.reduce((total, record) => total + record.messageCount, 0),
      bytesTotal: records.reduce((total, record) => total + record.bytesTotal, 0),
      evictedTopics: catalog?.evictedTopics ?? 0,
      ignoredTopics: catalog?.ignoredTopics ?? 0,
    });
  }

  #catalogOf(brokerId: BrokerId): BrokerCatalog {
    const existing = this.#brokers.get(brokerId);
    if (existing !== undefined) {
      return existing;
    }
    const created: BrokerCatalog = { records: new Map(), evictedTopics: 0, ignoredTopics: 0 };
    this.#brokers.set(brokerId, created);
    return created;
  }

  #allRecords(brokerId: BrokerId | undefined): TopicRecord[] {
    if (brokerId !== undefined) {
      return [...(this.#brokers.get(brokerId)?.records.values() ?? [])];
    }
    return [...this.#brokers.values()].flatMap((catalog) => [...catalog.records.values()]);
  }

  #matches(record: TopicRecord, query: TopicQuery): boolean {
    if (query.filter !== undefined && !matchesTopic(query.filter, record.topic)) {
      return false;
    }
    if (
      query.text !== undefined &&
      !record.topic.toLowerCase().includes(query.text.toLowerCase())
    ) {
      return false;
    }
    if (query.payloadKind !== undefined && (record.payloadKinds[query.payloadKind] ?? 0) === 0) {
      return false;
    }
    if (query.activeSince !== undefined && (record.lastLiveAt ?? 0) < query.activeSince) {
      return false;
    }
    if (query.silentSince !== undefined && (record.lastLiveAt ?? 0) >= query.silentSince) {
      return false;
    }
    if (query.firstSeenSince !== undefined && record.firstSeenAt < query.firstSeenSince) {
      return false;
    }
    return true;
  }
}

function levelsOf(topic: string): readonly string[] {
  return topic.split('/');
}

function startsWithLevels(topic: TopicName, root: readonly string[]): boolean {
  const levels = levelsOf(topic);
  return root.every((level, index) => levels[index] === level);
}

/** Segments differing only in a number or an identifier share a shape. */
const DIGIT_RUN = /\d+/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The shape of a level name, with its variable part replaced.
 *
 * `f1` and `f2` share `f#`; two device uuids share `<uuid>`. A name with nothing variable is
 * its own shape, which is what stops unrelated siblings being folded together.
 */
function shapeOf(segment: string): string {
  if (UUID.test(segment)) {
    return '<uuid>';
  }
  return segment.replace(DIGIT_RUN, '#');
}

/** Distinct sibling names sharing a shape before folding is worth doing. */
const MIN_FOLDED_BRANCHES = 3;

/**
 * Folds sibling groups whose names share a shape.
 *
 * A tree with five thousand device branches tells a reader nothing; the same tree with one
 * `device-#` branch tells them the system is keyed by device id, which is the fact they were
 * after. The fold is always reported, never silent, and the folded segment is a shape rather
 * than a real level, so it is not a path anyone can subscribe to.
 */
function foldGroups(
  groups: Map<string, TopicRecord[]>,
): { segment: string; records: TopicRecord[]; folded: number }[] {
  const byShape = new Map<string, string[]>();
  for (const segment of groups.keys()) {
    const shape = shapeOf(segment);
    const names = byShape.get(shape);
    if (names === undefined) {
      byShape.set(shape, [segment]);
    } else {
      names.push(segment);
    }
  }

  const folded: { segment: string; records: TopicRecord[]; folded: number }[] = [];
  for (const [shape, names] of byShape) {
    if (names.length < MIN_FOLDED_BRANCHES || (names.length === 1 && names[0] === shape)) {
      for (const name of names) {
        folded.push({ segment: name, records: groups.get(name) ?? [], folded: 0 });
      }
      continue;
    }
    folded.push({
      segment: shape,
      records: names.flatMap((name) => groups.get(name) ?? []),
      folded: names.length,
    });
  }
  return folded;
}

function buildNode(
  path: readonly string[],
  records: readonly TopicRecord[],
  depth: number,
  maxChildren: number,
  foldPatterns: boolean,
  foldedBranches = 0,
): TopicTreeNode {
  const topicCount = records.length;
  const messageCount = records.reduce((total, record) => total + record.messageCount, 0);
  const lastSeenAt = records.reduce<number | undefined>(
    (latest, record) =>
      latest === undefined ? record.lastSeenAt : Math.max(latest, record.lastSeenAt),
    undefined,
  );
  const isTopic = records.some((record) => levelsOf(record.topic).length === path.length);

  const base: Omit<TopicTreeNode, 'children' | 'truncatedChildren'> = {
    segment: path.at(-1) ?? '',
    path: path.join('/'),
    topicCount,
    messageCount,
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    isTopic,
  };

  const fold = foldedBranches > 0 ? { foldedBranches } : {};
  if (depth <= 0) {
    return { ...base, ...fold, children: [], truncatedChildren: 0 };
  }

  const groups = new Map<string, TopicRecord[]>();
  for (const record of records) {
    const levels = levelsOf(record.topic);
    const segment = levels[path.length];
    if (segment === undefined) {
      continue;
    }
    const group = groups.get(segment);
    if (group === undefined) {
      groups.set(segment, [record]);
    } else {
      group.push(record);
    }
  }

  const entries = foldPatterns
    ? foldGroups(groups)
    : [...groups.entries()].map(([segment, records]) => ({ segment, records, folded: 0 }));
  const sorted = entries.sort(
    (left, right) =>
      right.records.length - left.records.length || left.segment.localeCompare(right.segment),
  );
  const visible = sorted.slice(0, maxChildren);

  return {
    ...base,
    ...fold,
    children: visible.map((entry) =>
      buildNode(
        [...path, entry.segment],
        entry.records,
        depth - 1,
        maxChildren,
        foldPatterns,
        entry.folded,
      ),
    ),
    truncatedChildren: sorted.length - visible.length,
  };
}

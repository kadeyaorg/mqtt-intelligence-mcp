/**
 * The `TopicCatalog` port (ADR-0008).
 *
 * The catalog and the message log are two ports, not one, because their access patterns are
 * opposite: the catalog is one aggregated record per topic, updated on every message, while
 * the log is append-only and bounded by retention. A database implementation would model
 * them differently, and a single interface would make one of the two awkward.
 *
 * Writes are batched and queries are cursor-paginated for the same reason: both are what a
 * real store needs, and both are harmless in memory.
 */
import type { BrokerId } from '../domain/ids.js';
import type { TopicFilter, TopicName } from '../domain/topic.js';
import type { PayloadKind } from '../payload/index.js';
import type { TopicDelta, TopicRecord } from './record.js';

export interface Page<Item> {
  readonly items: readonly Item[];
  /** Opaque: pass it back to continue. Absent when there is nothing more. */
  readonly nextCursor?: string;
}

export type TopicSortKey = 'topic' | 'lastSeenAt' | 'messageCount' | 'rate';

export interface TopicQuery {
  readonly brokerId?: BrokerId;
  /** MQTT filter the topic must match. */
  readonly filter?: TopicFilter;
  /** Case-insensitive substring of the topic name. */
  readonly text?: string;
  readonly payloadKind?: PayloadKind;
  /** Only topics whose last live message is at or after this instant. */
  readonly activeSince?: number;
  /** Only topics silent since this instant, which is how "what stopped?" is asked. */
  readonly silentSince?: number;
  readonly sortBy?: TopicSortKey;
  readonly descending?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TreeQuery {
  /**
   * Fold sibling branches whose names differ only in a number or an identifier. Default true.
   *
   * A namespace keyed by device id is unreadable one branch at a time, and the shape is what
   * the reader actually wants. Turn it off to see every branch as published.
   */
  readonly foldPatterns?: boolean;
  readonly brokerId?: BrokerId;
  /** Levels to start from, for example `["factory", "line-01"]`. */
  readonly root?: readonly string[];
  readonly depth?: number;
  /** Children beyond this count are summarised rather than listed. */
  readonly maxChildren?: number;
}

export interface TopicTreeNode {
  /** The level this node represents; empty at the root. */
  readonly segment: string;
  /** Full path from the root, joined with "/". */
  readonly path: string;
  /** Topics at or below this node. */
  readonly topicCount: number;
  readonly messageCount: number;
  readonly lastSeenAt?: number;
  /** True when a topic is published at exactly this path. */
  readonly isTopic: boolean;
  readonly children: readonly TopicTreeNode[];
  /** Children not listed because of `maxChildren`. */
  readonly truncatedChildren: number;
  /**
   * Sibling branches folded into this one because their names share a shape.
   *
   * Absent when nothing was folded. When set, `segment` is the shape rather than any real
   * level, so the path is not a topic filter and must not be used as one.
   */
  readonly foldedBranches?: number;
}

export interface CatalogBatchResult {
  /** Deltas that updated or created a record. */
  readonly applied: number;
  /** Topics dropped to stay within the per-broker limit. */
  readonly evicted: number;
  /** Deltas refused because the limit was reached and eviction is disabled. */
  readonly ignored: number;
}

export interface CatalogStats {
  readonly brokerId: BrokerId;
  readonly topicCount: number;
  readonly messageCount: number;
  readonly bytesTotal: number;
  /** Topics dropped since start, which an agent must know before trusting a listing. */
  readonly evictedTopics: number;
  readonly ignoredTopics: number;
}

export interface TopicCatalog {
  /** Folds a flush's worth of deltas into the records. */
  applyBatch(brokerId: BrokerId, deltas: readonly TopicDelta[]): Promise<CatalogBatchResult>;
  get(brokerId: BrokerId, topic: TopicName): Promise<TopicRecord | undefined>;
  query(query: TopicQuery): Promise<Page<TopicRecord>>;
  tree(query: TreeQuery): Promise<TopicTreeNode>;
  stats(brokerId: BrokerId): Promise<CatalogStats>;
}

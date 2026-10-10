/**
 * The `MessageStore` port (ADR-0008).
 *
 * An append-only log of the messages ingestion decided to keep. It is deliberately **not**
 * every message: counting is exact, keeping is bounded (ADR-0009), so a reader must be able
 * to tell what it is looking at. `stats()` reports what was dropped, and the query layer
 * turns that into a limitation an agent can see.
 */
import type { BrokerId } from '../domain/ids.js';
import type { TopicFilter, TopicName } from '../domain/topic.js';
import type { Page } from '../catalog/index.js';
import type { ObservedMessage } from './message.js';

export interface MessageQuery {
  readonly brokerId?: BrokerId;
  readonly topic?: TopicName;
  readonly filter?: TopicFilter;
  /** Receipt time at or after this instant. */
  readonly from?: number;
  /** Receipt time strictly before this instant. */
  readonly to?: number;
  readonly limit?: number;
  readonly cursor?: string;
  /** Newest first by default, which is what "what is happening now" wants. */
  readonly ascending?: boolean;
}

export interface MessageStoreStats {
  readonly messageCount: number;
  readonly bytesStored: number;
  /** Messages dropped to stay within the configured budgets. */
  readonly evictedMessages: number;
  readonly topicCount: number;
}

export interface MessageStore {
  /** One flush's worth of messages. */
  append(messages: readonly ObservedMessage[]): Promise<void>;
  /** Newest first. */
  recent(brokerId: BrokerId, topic: TopicName, limit: number): Promise<readonly ObservedMessage[]>;
  query(query: MessageQuery): Promise<Page<ObservedMessage>>;
  stats(): Promise<MessageStoreStats>;
}

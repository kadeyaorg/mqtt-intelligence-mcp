/**
 * The in-memory message log (ADR-0008, ADR-0009).
 *
 * Two bounds, because one is not enough: a per-topic ring keeps a chatty topic from pushing
 * every other topic's history out, and a global byte budget keeps the process alive whatever
 * the payload sizes. Whatever is dropped is counted, and the count is reported, because an
 * agent reading a history must be able to tell "this is all of it" from "this is what was
 * kept".
 */
import type { BrokerId } from '../../domain/ids.js';
import type { TopicName } from '../../domain/topic.js';
import { matchesTopic } from '../../domain/topic.js';
import type { Page } from '../../catalog/index.js';
import type { ObservedMessage } from '../message.js';
import type { MessageQuery, MessageStore, MessageStoreStats } from '../port.js';

export interface MemoryMessageStoreOptions {
  readonly messagesPerTopic?: number;
  readonly maxBytes?: number;
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
}

const DEFAULTS = {
  messagesPerTopic: 20,
  maxBytes: 128 * 1024 * 1024,
  defaultLimit: 50,
  maxLimit: 500,
};

interface StoredEntry {
  readonly message: ObservedMessage;
  readonly bytes: number;
  /** Global insertion order, used to evict the oldest first. */
  readonly order: number;
}

function keyOf(brokerId: BrokerId, topic: TopicName): string {
  return `${brokerId}\u0000${topic}`;
}

export class MemoryMessageStore implements MessageStore {
  readonly #byTopic = new Map<string, StoredEntry[]>();
  readonly #options: Required<MemoryMessageStoreOptions>;
  #bytesStored = 0;
  #evicted = 0;
  #nextOrder = 1;

  constructor(options: MemoryMessageStoreOptions = {}) {
    this.#options = {
      messagesPerTopic: options.messagesPerTopic ?? DEFAULTS.messagesPerTopic,
      maxBytes: options.maxBytes ?? DEFAULTS.maxBytes,
      defaultLimit: options.defaultLimit ?? DEFAULTS.defaultLimit,
      maxLimit: options.maxLimit ?? DEFAULTS.maxLimit,
    };
  }

  append(messages: readonly ObservedMessage[]): Promise<void> {
    for (const message of messages) {
      this.#appendOne(message);
    }
    this.#enforceByteBudget();
    return Promise.resolve();
  }

  recent(brokerId: BrokerId, topic: TopicName, limit: number): Promise<readonly ObservedMessage[]> {
    const entries = this.#byTopic.get(keyOf(brokerId, topic)) ?? [];
    const newestFirst = [...entries].reverse().slice(0, Math.max(0, limit));
    return Promise.resolve(newestFirst.map((entry) => entry.message));
  }

  query(query: MessageQuery): Promise<Page<ObservedMessage>> {
    const limit = Math.min(query.limit ?? this.#options.defaultLimit, this.#options.maxLimit);
    const ascending = query.ascending === true;

    const matching = this.#allEntries()
      .filter((entry) => this.#matches(entry.message, query))
      .sort((left, right) => (ascending ? left.order - right.order : right.order - left.order));

    const cursor = query.cursor === undefined ? undefined : Number.parseInt(query.cursor, 10);
    const start =
      cursor === undefined || Number.isNaN(cursor)
        ? 0
        : matching.findIndex((entry) => (ascending ? entry.order > cursor : entry.order < cursor));

    const items = start < 0 ? [] : matching.slice(start, start + limit);
    const last = items.at(-1);
    const hasMore = start >= 0 && start + items.length < matching.length;

    return Promise.resolve({
      items: items.map((entry) => entry.message),
      // The cursor is the global order of the last item: resuming is exact even if the
      // store changed in between.
      ...(hasMore && last !== undefined ? { nextCursor: String(last.order) } : {}),
    });
  }

  stats(): Promise<MessageStoreStats> {
    return Promise.resolve({
      messageCount: this.#allEntries().length,
      bytesStored: this.#bytesStored,
      evictedMessages: this.#evicted,
      topicCount: this.#byTopic.size,
    });
  }

  #appendOne(message: ObservedMessage): void {
    const key = keyOf(message.brokerId, message.topic);
    const entries = this.#byTopic.get(key) ?? [];
    if (entries.length === 0) {
      this.#byTopic.set(key, entries);
    }

    entries.push({
      message,
      bytes: message.payload.bytes.byteLength,
      order: this.#nextOrder++,
    });
    this.#bytesStored += message.payload.bytes.byteLength;

    while (entries.length > this.#options.messagesPerTopic) {
      const dropped = entries.shift();
      if (dropped !== undefined) {
        this.#bytesStored -= dropped.bytes;
        this.#evicted += 1;
      }
    }
  }

  /** Drops the globally oldest messages until the budget is respected. */
  #enforceByteBudget(): void {
    while (this.#bytesStored > this.#options.maxBytes) {
      let oldestKey: string | undefined;
      let oldestOrder = Number.POSITIVE_INFINITY;
      for (const [key, entries] of this.#byTopic) {
        const first = entries[0];
        if (first !== undefined && first.order < oldestOrder) {
          oldestOrder = first.order;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) {
        return;
      }
      const entries = this.#byTopic.get(oldestKey);
      const dropped = entries?.shift();
      if (dropped === undefined) {
        return;
      }
      this.#bytesStored -= dropped.bytes;
      this.#evicted += 1;
      if (entries?.length === 0) {
        this.#byTopic.delete(oldestKey);
      }
    }
  }

  #allEntries(): StoredEntry[] {
    return [...this.#byTopic.values()].flat();
  }

  #matches(message: ObservedMessage, query: MessageQuery): boolean {
    if (query.brokerId !== undefined && message.brokerId !== query.brokerId) {
      return false;
    }
    if (query.topic !== undefined && message.topic !== query.topic) {
      return false;
    }
    if (query.filter !== undefined && !matchesTopic(query.filter, message.topic)) {
      return false;
    }
    if (query.from !== undefined && message.receivedAt < query.from) {
      return false;
    }
    if (query.to !== undefined && message.receivedAt >= query.to) {
      return false;
    }
    return true;
  }
}

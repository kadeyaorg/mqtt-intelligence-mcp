/**
 * Turning stored records into answers.
 *
 * These functions are where the catalog's vocabulary becomes an agent's: counts stay counts,
 * computed values are labelled as such with the method that produced them, and the payloads
 * go through the safe view on the way out (ADR-0010).
 */
import type {
  Page,
  TopicCatalog,
  TopicQuery,
  TopicRecord,
  TopicTreeNode,
  TreeQuery,
} from '../catalog/index.js';
import { decayRate, intervalGroups, silenceRatio, standardDeviation } from '../catalog/index.js';
import type { BrokerId } from '../domain/ids.js';
import type { QoS } from '../domain/mqtt.js';
import type { TopicName } from '../domain/topic.js';
import type { IntervalGroup, PayloadKindCounts, RetainedState } from '../catalog/index.js';
import type { MessageProperties } from '../domain/mqtt.js';
import type {
  PayloadView,
  PayloadViewOptions,
  SchemaChange,
  SchemaField,
} from '../payload/index.js';
import { flattenSchema, schemaChanges, toPayloadView } from '../payload/index.js';
import type { MessageStore, ObservedMessage } from '../store/index.js';

export interface TopicSummary {
  readonly brokerId: BrokerId;
  readonly topic: TopicName;
  readonly messageCount: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly lastLiveAt?: number;
  readonly payloadKinds: PayloadKindCounts;
  readonly retainedState: RetainedState;
  /** Decayed to now, so a topic that stopped does not keep its old rate. */
  readonly messagesPerSecond: number;
}

export interface MessageFact {
  readonly receivedAt: number;
  readonly sequence: number;
  readonly deliveredQos: QoS;
  readonly retainedReplay: boolean;
  readonly payloadSize: number;
  readonly payload: PayloadView;
  readonly properties?: MessageProperties;
}

export interface TopicFacts {
  readonly brokerId: BrokerId;
  readonly topic: TopicName;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly lastLiveAt?: number;
  readonly messageCount: number;
  readonly retainedReplayCount: number;
  readonly bytesTotal: number;
  readonly maxPayloadSize: number;
  readonly deliveredQosCounts: {
    readonly qos0: number;
    readonly qos1: number;
    readonly qos2: number;
  };
  readonly retainedState: RetainedState;
  readonly payloadKinds: PayloadKindCounts;
  readonly inspectedCount: number;
  readonly lastMessage?: MessageFact;
}

export interface IntervalObservation {
  readonly count: number;
  readonly meanMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly standardDeviationMs?: number;
}

export interface SchemaObservation {
  /** Payloads folded into this shape. Ingestion samples, so this is not the message count. */
  readonly payloadsInspected: number;
  readonly fields: readonly SchemaField[];
  /**
   * Positions whose observation window does not match the topic's.
   *
   * A field that stopped appearing and another that started at the same moment is what a
   * rename looks like from here. It is not called one: two unrelated changes look identical,
   * and only someone who knows the firmware can tell which it was.
   */
  readonly changes: readonly SchemaChange[];
  /** True when a limit stopped inference somewhere inside.*/
  readonly truncated: boolean;
}

export interface TopicObservations {
  readonly messagesPerSecond: number;
  /** How that number was produced, so it is never mistaken for a raw count. */
  readonly rateMethod: string;
  readonly interArrival?: IntervalObservation;
  /**
   * Groups of inter-arrival times, reported only when there is more than one.
   *
   * Two groups mean the gaps fall into two populations — a short one and a long one — which
   * a topic published once per cycle does not have. What produces them is not something
   * arrival times can settle, so nothing here says why.
   */
  readonly intervalGroups?: readonly IntervalGroup[];
  /**
   * The shape of the JSON payloads inspected so far.
   *
   * A summary of what was seen, not a contract: a field with a presence below 1 was absent
   * from some payloads, which is not the same as being optional by design.
   */
  readonly schema?: SchemaObservation;
  readonly silence?: {
    readonly forMs: number;
    /** How many typical intervals of silence this is. */
    readonly ratioToMeanInterval: number;
  };
}

export function toSummary(record: TopicRecord, now: number): TopicSummary {
  return {
    brokerId: record.brokerId,
    topic: record.topic,
    messageCount: record.messageCount,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    ...(record.lastLiveAt === undefined ? {} : { lastLiveAt: record.lastLiveAt }),
    payloadKinds: record.payloadKinds,
    retainedState: record.retainedState,
    messagesPerSecond: decayRate(record.rate, now).perSecond,
  };
}

export function toMessageFact(
  message: ObservedMessage,
  viewOptions: PayloadViewOptions,
): MessageFact {
  return {
    receivedAt: message.receivedAt,
    sequence: message.sequence,
    deliveredQos: message.deliveredQos,
    retainedReplay: message.retainedReplay,
    payloadSize: message.payload.size,
    payload: toPayloadView(message.payload.bytes, {
      ...viewOptions,
      classification: message.payload.classification,
      originalSize: message.payload.size,
      truncated: message.payload.truncated,
    }),
    ...(message.properties === undefined ? {} : { properties: message.properties }),
  };
}

export function toTopicFacts(
  record: TopicRecord,
  lastMessage: ObservedMessage | undefined,
  viewOptions: PayloadViewOptions,
): TopicFacts {
  return {
    brokerId: record.brokerId,
    topic: record.topic,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    ...(record.lastLiveAt === undefined ? {} : { lastLiveAt: record.lastLiveAt }),
    messageCount: record.messageCount,
    retainedReplayCount: record.retainedReplayCount,
    bytesTotal: record.bytesTotal,
    maxPayloadSize: record.maxPayloadSize,
    deliveredQosCounts: {
      qos0: record.qosCounts[0],
      qos1: record.qosCounts[1],
      qos2: record.qosCounts[2],
    },
    retainedState: record.retainedState,
    payloadKinds: record.payloadKinds,
    inspectedCount: record.inspectedCount,
    ...(lastMessage === undefined ? {} : { lastMessage: toMessageFact(lastMessage, viewOptions) }),
  };
}

export function toTopicObservations(record: TopicRecord, now: number): TopicObservations {
  const interArrival = record.interArrival;
  const ratio = silenceRatio(record, now);
  const deviation = standardDeviation(interArrival);
  const groups = intervalGroups(record.intervalBuckets);

  return {
    messagesPerSecond: decayRate(record.rate, now).perSecond,
    rateMethod:
      'exponentially decayed with a 60 s time constant, counting live messages only; retained replays are excluded',
    ...(interArrival.count === 0
      ? {}
      : {
          interArrival: {
            count: interArrival.count,
            meanMs: interArrival.mean,
            minMs: interArrival.min,
            maxMs: interArrival.max,
            ...(deviation === undefined ? {} : { standardDeviationMs: deviation }),
          },
        }),
    ...(groups.length === 0 ? {} : { intervalGroups: groups }),
    ...(record.schema === undefined || record.schema.seen === 0
      ? {}
      : {
          schema: {
            payloadsInspected: record.schema.seen,
            fields: flattenSchema(record.schema),
            changes: schemaChanges(record.schema),
            truncated: record.schema.truncated === true,
          },
        }),
    ...(ratio === undefined || record.lastLiveAt === undefined
      ? {}
      : {
          silence: {
            forMs: now - record.lastLiveAt,
            ratioToMeanInterval: ratio,
          },
        }),
  };
}

export async function searchTopics(
  catalog: TopicCatalog,
  query: TopicQuery,
  now: number,
): Promise<{ page: Page<TopicRecord>; summaries: readonly TopicSummary[] }> {
  const page = await catalog.query(query);
  return { page, summaries: page.items.map((record) => toSummary(record, now)) };
}

export async function topicTree(catalog: TopicCatalog, query: TreeQuery): Promise<TopicTreeNode> {
  return catalog.tree(query);
}

export async function recentMessages(
  store: MessageStore,
  brokerId: BrokerId,
  topic: TopicName,
  limit: number,
  viewOptions: PayloadViewOptions,
): Promise<readonly MessageFact[]> {
  const messages = await store.recent(brokerId, topic, limit);
  return messages.map((message) => toMessageFact(message, viewOptions));
}

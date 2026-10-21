/**
 * The ingest pipeline: count everything, inspect a sample, store a bounded window (ADR-0009).
 *
 * A `#` subscription on a busy broker delivers tens of thousands of messages per second, and
 * MQTT offers no way to ask for less: pausing the socket delays keepalive handling until the
 * broker drops us. So the shape of this file is dictated by one rule — **the handler that
 * receives a message must stay O(1) and synchronous**.
 *
 * Per message, on the hot path: a policy check, a few counter updates, and a reference to the
 * latest payload. No parsing, no hashing, no awaiting, no allocation that grows with traffic.
 *
 * Everything expensive happens on the flush tick: copying and truncating one payload per
 * topic, classifying up to a budget, and handing batches to the stores. What that costs the
 * caller is accuracy of *history*, never of *counts*: message counts are exact, the last
 * message is exact, and the history in between is sampled at no more than one message per
 * topic per flush. Whatever is dropped is counted and reported, never silently lost.
 */
import type { TopicDelta } from '../catalog/index.js';
import { EMPTY_DISTRIBUTION, observeInterval, observeValue } from '../catalog/index.js';
import type { Clock, Timer } from '../domain/clock.js';
import { systemClock } from '../domain/clock.js';
import type { BrokerId } from '../domain/ids.js';
import type { TopicName } from '../domain/topic.js';
import { isTopicName } from '../domain/topic.js';
import type { Logger, MetricsRecorder } from '../observability/index.js';
import { noopLogger, noopMetrics } from '../observability/index.js';
import type { PayloadDecoder, PayloadKind, SchemaNode } from '../payload/index.js';
import { classifyWithValue, observeJson, runDecoders } from '../payload/index.js';
import type { ReadPolicy } from '../policy/index.js';
import type { TopicCatalog } from '../catalog/index.js';
import type { MessageStore, ObservedMessage } from '../store/index.js';
import type { InboundMessage } from '../transport/index.js';

export interface IngestLimits {
  /** Payloads larger than this are never parsed. */
  readonly maxInspectBytes: number;
  /** Bytes kept per stored payload. */
  readonly maxStoredPayloadBytes: number;
  /** Payload references waiting for a flush; beyond this, payloads are dropped. */
  readonly pendingPayloadMaxBytes: number;
  readonly flushIntervalMs: number;
  /** Payloads classified per flush, so one burst cannot monopolise the event loop. */
  readonly inspectionsPerFlush: number;
  /** Per-topic last-arrival memory, which bounds inter-arrival tracking. */
  readonly maxTrackedTopics: number;
}

export const DEFAULT_INGEST_LIMITS: IngestLimits = {
  maxInspectBytes: 256 * 1024,
  maxStoredPayloadBytes: 8192,
  pendingPayloadMaxBytes: 64 * 1024 * 1024,
  flushIntervalMs: 100,
  inspectionsPerFlush: 2000,
  maxTrackedTopics: 50_000,
};

export interface IngestCounters {
  /** Messages accepted for counting. */
  readonly received: number;
  readonly bytesReceived: number;
  /** Messages the read policy refused: never counted, never stored. */
  readonly denied: number;
  /** Messages whose topic the broker sent but MQTT forbids. */
  readonly invalidTopics: number;
  /** Payloads dropped because the pending budget was full. */
  readonly payloadsDropped: number;
  /** Payloads not classified because the flush budget was spent. */
  readonly notInspected: number;
  /** Times a decoder threw. The decoder is at fault, not the payload. */
  readonly decoderErrors: number;
  readonly flushes: number;
}

export interface IngestPipelineDependencies {
  readonly brokerId: BrokerId;
  readonly policy: ReadPolicy;
  readonly catalog: TopicCatalog;
  readonly messageStore: MessageStore;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly metrics?: MetricsRecorder;
  readonly limits?: Partial<IngestLimits>;
  /**
   * Decoders offered any payload the classifier could only call binary, in order.
   *
   * None ship with the core: each format carries a dependency or a specification of its own.
   */
  readonly decoders?: readonly PayloadDecoder[];
}

/** What one topic accumulated since the last flush. */
interface TopicAccumulator {
  firstSeenAt: number;
  lastSeenAt: number;
  lastLiveAt: number | undefined;
  messageCount: number;
  retainedReplayCount: number;
  liveCount: number;
  bytesTotal: number;
  maxPayloadSize: number;
  qosCounts: [number, number, number];
  interArrival: typeof EMPTY_DISTRIBUTION;
  intervalBuckets: readonly number[] | undefined;
  schema: SchemaNode | undefined;
  retainedState: 'present' | 'cleared' | undefined;
  /** The latest payload of this topic, not copied yet. */
  pending: InboundMessage | undefined;
  pendingAt: number;
  pendingSequence: number;
}

const METRIC_RECEIVED = 'mqtt_intelligence.messages.received';
const METRIC_BYTES = 'mqtt_intelligence.messages.bytes';
const METRIC_DENIED = 'mqtt_intelligence.messages.denied';
const METRIC_DROPPED = 'mqtt_intelligence.payloads.dropped';
const METRIC_FLUSH = 'mqtt_intelligence.ingest.flush.duration';

export class IngestPipeline {
  readonly #brokerId: BrokerId;
  readonly #policy: ReadPolicy;
  readonly #decoders: readonly PayloadDecoder[];
  readonly #catalog: TopicCatalog;
  readonly #messageStore: MessageStore;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #limits: IngestLimits;

  readonly #received;
  readonly #bytes;
  readonly #deniedCounter;
  readonly #droppedCounter;
  readonly #flushDuration;

  #accumulator = new Map<TopicName, TopicAccumulator>();
  /** Last live arrival per topic, so inter-arrival survives across flushes. */
  readonly #lastLiveAt = new Map<TopicName, number>();
  #pendingBytes = 0;
  #sequence = 0;
  #timer: Timer | undefined;
  #running = false;
  #flushing: Promise<void> = Promise.resolve();

  #counters: IngestCounters = {
    received: 0,
    bytesReceived: 0,
    denied: 0,
    invalidTopics: 0,
    payloadsDropped: 0,
    notInspected: 0,
    decoderErrors: 0,
    flushes: 0,
  };

  constructor(dependencies: IngestPipelineDependencies) {
    this.#brokerId = dependencies.brokerId;
    this.#policy = dependencies.policy;
    this.#catalog = dependencies.catalog;
    this.#messageStore = dependencies.messageStore;
    this.#clock = dependencies.clock ?? systemClock;
    this.#logger = (dependencies.logger ?? noopLogger).child({
      broker: dependencies.brokerId,
      component: 'ingest',
    });
    this.#limits = { ...DEFAULT_INGEST_LIMITS, ...dependencies.limits };
    this.#decoders = dependencies.decoders ?? [];

    const metrics = dependencies.metrics ?? noopMetrics;
    this.#received = metrics.counter(METRIC_RECEIVED, { description: 'Messages observed.' });
    this.#bytes = metrics.counter(METRIC_BYTES, {
      unit: 'By',
      description: 'Payload bytes observed.',
    });
    this.#deniedCounter = metrics.counter(METRIC_DENIED, {
      description: 'Messages the read policy refused.',
    });
    this.#droppedCounter = metrics.counter(METRIC_DROPPED, {
      description: 'Payloads dropped before inspection.',
    });
    this.#flushDuration = metrics.histogram(METRIC_FLUSH, { unit: 'ms' });
  }

  get counters(): IngestCounters {
    return this.#counters;
  }

  /** Topics waiting to be written at the next flush. */
  get pendingTopicCount(): number {
    return this.#accumulator.size;
  }

  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#arm();
  }

  /** Flushes what is pending and stops the timer. */
  async stop(): Promise<void> {
    this.#running = false;
    this.#timer?.cancel();
    this.#timer = undefined;
    await this.#flushing;
    await this.flush();
  }

  /**
   * The hot path.
   *
   * Everything here is O(1) and synchronous on purpose: this runs inside the transport's
   * message handler, and holding it holds the keepalive with it.
   */
  accept(message: InboundMessage): void {
    const at = this.#clock.now();

    if (!isTopicName(message.topic)) {
      // A broker should never send one, but a malformed topic must not reach the catalog.
      this.#counters = { ...this.#counters, invalidTopics: this.#counters.invalidTopics + 1 };
      return;
    }
    const topic = message.topic;

    if (!this.#policy.isReadable(topic)) {
      this.#counters = { ...this.#counters, denied: this.#counters.denied + 1 };
      this.#deniedCounter.add(1, { broker: this.#brokerId });
      return;
    }

    const size = message.payload.byteLength;
    // A retain flag on delivery means the broker replayed what it had kept: it is not
    // evidence that anything was published just now (ADR-0011).
    const retainedReplay = message.retain;
    const accumulator = this.#accumulatorFor(topic, at);

    accumulator.lastSeenAt = at;
    accumulator.messageCount += 1;
    accumulator.bytesTotal += size;
    accumulator.maxPayloadSize = Math.max(accumulator.maxPayloadSize, size);
    accumulator.qosCounts[message.qos] += 1;

    if (retainedReplay) {
      accumulator.retainedReplayCount += 1;
      accumulator.retainedState = size === 0 ? 'cleared' : 'present';
    } else {
      accumulator.liveCount += 1;
      const previous = this.#lastLiveAt.get(topic);
      if (previous !== undefined) {
        const gap = at - previous;
        accumulator.interArrival = observeValue(accumulator.interArrival, gap);
        accumulator.intervalBuckets = observeInterval(accumulator.intervalBuckets, gap);
      }
      accumulator.lastLiveAt = at;
      this.#rememberLiveArrival(topic, at);
    }

    this.#counters = {
      ...this.#counters,
      received: this.#counters.received + 1,
      bytesReceived: this.#counters.bytesReceived + size,
    };
    this.#received.add(1, { broker: this.#brokerId });
    this.#bytes.add(size, { broker: this.#brokerId });

    this.#holdPayload(accumulator, message, at, size);
  }

  /** Writes everything accumulated so far. Safe to call at any time. */
  async flush(): Promise<void> {
    if (this.#accumulator.size === 0) {
      return;
    }
    const batch = this.#accumulator;
    this.#accumulator = new Map();
    this.#pendingBytes = 0;

    const startedAt = this.#clock.monotonic();
    const deltas: TopicDelta[] = [];
    const messages: ObservedMessage[] = [];
    let inspections = 0;
    let notInspected = 0;
    let decoderErrors = 0;

    for (const [topic, accumulator] of batch) {
      const payloadKinds: Partial<Record<PayloadKind, number>> = {};
      let inspectedCount = 0;

      const pending = accumulator.pending;
      if (pending !== undefined) {
        const inspect = inspections < this.#limits.inspectionsPerFlush;
        const inspected = inspect
          ? classifyWithValue(pending.payload, { maxInspectBytes: this.#limits.maxInspectBytes })
          : { classification: { kind: 'unknown', reason: 'budget-exhausted' } as const };
        let classification = inspected.classification;
        let structure = inspected.json;

        // Binary is the classifier saying "I cannot read this", which is exactly where a
        // decoder earns its place. Nothing it produces escapes the inspection budget: this
        // runs for the one payload per topic that was going to be inspected anyway.
        if (inspect && classification.kind === 'binary' && this.#decoders.length > 0) {
          const result = runDecoders(
            pending.payload,
            {
              topic,
              ...(pending.properties?.contentType === undefined
                ? {}
                : { contentType: pending.properties.contentType }),
              ...(pending.properties?.userProperties === undefined
                ? {}
                : { userProperties: pending.properties.userProperties }),
            },
            this.#decoders,
          );
          for (const failure of result.failures) {
            decoderErrors += 1;
            this.#logger.warn('A payload decoder threw', {
              decoder: failure.decoder,
              topic,
              error: failure.error,
            });
          }
          if (result.outcome !== undefined) {
            classification = { kind: 'decoded', decodedBy: result.outcome.decoder };
            structure = result.outcome.value;
          }
        }

        if (inspect) {
          inspections += 1;
          inspectedCount = 1;
          payloadKinds[classification.kind] = 1;
          if (structure !== undefined) {
            // The shape rides on the payloads that were going to be parsed anyway, so
            // inference costs no extra parse and obeys the same inspection budget. A
            // decoded payload has a shape like any other, and gets one.
            accumulator.schema = observeJson(accumulator.schema, structure, accumulator.pendingAt);
          }
        } else {
          notInspected += 1;
        }

        messages.push(this.#toObservedMessage(topic, pending, accumulator, classification));
      }

      deltas.push({
        topic,
        firstSeenAt: accumulator.firstSeenAt,
        lastSeenAt: accumulator.lastSeenAt,
        ...(accumulator.lastLiveAt === undefined ? {} : { lastLiveAt: accumulator.lastLiveAt }),
        messageCount: accumulator.messageCount,
        retainedReplayCount: accumulator.retainedReplayCount,
        bytesTotal: accumulator.bytesTotal,
        maxPayloadSize: accumulator.maxPayloadSize,
        qosCounts: accumulator.qosCounts,
        ...(accumulator.retainedState === undefined
          ? {}
          : { retainedState: accumulator.retainedState }),
        payloadKinds,
        inspectedCount,
        liveCount: accumulator.liveCount,
        interArrival: accumulator.interArrival,
        ...(accumulator.intervalBuckets === undefined
          ? {}
          : { intervalBuckets: accumulator.intervalBuckets }),
        ...(accumulator.schema === undefined ? {} : { schema: accumulator.schema }),
      });
    }

    const result = await this.#catalog.applyBatch(this.#brokerId, deltas);
    if (messages.length > 0) {
      await this.#messageStore.append(messages);
    }

    this.#counters = {
      ...this.#counters,
      notInspected: this.#counters.notInspected + notInspected,
      decoderErrors: this.#counters.decoderErrors + decoderErrors,
      flushes: this.#counters.flushes + 1,
    };
    this.#flushDuration.record(this.#clock.monotonic() - startedAt, { broker: this.#brokerId });

    if (result.evicted > 0 || result.ignored > 0) {
      this.#logger.warn('The topic limit was reached', {
        evicted: result.evicted,
        ignored: result.ignored,
      });
    }
  }

  #arm(): void {
    this.#timer = this.#clock.setTimeout(() => {
      this.#flushing = this.flush().catch((error: unknown) => {
        // A failing store must not stop ingestion: counting continues, and the next flush
        // tries again with whatever accumulated since.
        this.#logger.error('Flushing failed', { error });
      });
      if (this.#running) {
        this.#arm();
      }
    }, this.#limits.flushIntervalMs);
  }

  #accumulatorFor(topic: TopicName, at: number): TopicAccumulator {
    const existing = this.#accumulator.get(topic);
    if (existing !== undefined) {
      return existing;
    }
    const created: TopicAccumulator = {
      firstSeenAt: at,
      lastSeenAt: at,
      lastLiveAt: undefined,
      messageCount: 0,
      retainedReplayCount: 0,
      liveCount: 0,
      bytesTotal: 0,
      maxPayloadSize: 0,
      qosCounts: [0, 0, 0],
      interArrival: EMPTY_DISTRIBUTION,
      intervalBuckets: undefined,
      schema: undefined,
      retainedState: undefined,
      pending: undefined,
      pendingAt: at,
      pendingSequence: 0,
    };
    this.#accumulator.set(topic, created);
    return created;
  }

  /**
   * Keeps the latest payload of a topic for the next flush, within a byte budget.
   *
   * Only the latest is kept, so a topic publishing a thousand times between two flushes
   * costs one payload, and the one an agent would ask for — the last — is exact.
   */
  #holdPayload(
    accumulator: TopicAccumulator,
    message: InboundMessage,
    at: number,
    size: number,
  ): void {
    const previous = accumulator.pending;
    const previousSize = previous?.payload.byteLength ?? 0;

    if (previous === undefined && this.#pendingBytes + size > this.#limits.pendingPayloadMaxBytes) {
      this.#counters = {
        ...this.#counters,
        payloadsDropped: this.#counters.payloadsDropped + 1,
      };
      this.#droppedCounter.add(1, { broker: this.#brokerId, reason: 'budget' });
      return;
    }

    accumulator.pending = message;
    accumulator.pendingAt = at;
    this.#sequence += 1;
    accumulator.pendingSequence = this.#sequence;
    this.#pendingBytes += size - previousSize;
  }

  #rememberLiveArrival(topic: TopicName, at: number): void {
    if (this.#lastLiveAt.size >= this.#limits.maxTrackedTopics && !this.#lastLiveAt.has(topic)) {
      // Forget the least recently seen topic: inter-arrival is a nicety, memory is not.
      const oldest = this.#lastLiveAt.keys().next();
      if (!oldest.done) {
        this.#lastLiveAt.delete(oldest.value);
      }
    }
    this.#lastLiveAt.delete(topic);
    this.#lastLiveAt.set(topic, at);
  }

  #toObservedMessage(
    topic: TopicName,
    message: InboundMessage,
    accumulator: TopicAccumulator,
    classification: ObservedMessage['payload']['classification'],
  ): ObservedMessage {
    const size = message.payload.byteLength;
    const kept = Math.min(size, this.#limits.maxStoredPayloadBytes);
    // A copy, always: a slice would keep the whole network buffer alive.
    const bytes = message.payload.slice(0, kept);

    return {
      brokerId: this.#brokerId,
      topic,
      receivedAt: accumulator.pendingAt,
      sequence: accumulator.pendingSequence,
      deliveredQos: message.qos,
      retainFlag: message.retain,
      retainedReplay: message.retain,
      payload: {
        size,
        bytes,
        truncated: kept < size,
        classification,
      },
      ...(message.properties === undefined ? {} : { properties: message.properties }),
    };
  }
}

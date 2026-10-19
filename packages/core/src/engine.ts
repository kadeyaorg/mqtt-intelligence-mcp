/**
 * The engine: the whole library behind one object (ADR-0003).
 *
 * This is the composition root, and the only place that knows how the pieces fit: a
 * connection, a subscription manager, an ingest pipeline and a discovery service per broker,
 * all sharing one catalog, one message store, one clock, one logger.
 *
 * It is also the boundary of the public API. An MCP adapter, a CLI or a service talks to
 * `Engine` and nothing else — it cannot reach a transport, a store or a subscription, which
 * is what keeps every security decision inside the engine rather than in whatever is driving
 * it today.
 */
import type { TopicCatalog, TopicQuery, TopicTreeNode } from './catalog/index.js';
import { MemoryMessageStore, MemoryTopicCatalog } from './store/index.js';
import type { BrokerConfig, EngineConfig } from './config/index.js';
import { BrokerRegistry } from './broker/index.js';
import type { BrokerStatus, BrokerConnection } from './broker/index.js';
import type { ObservationCoverage } from './domain/coverage.js';
import type { Clock } from './domain/clock.js';
import { systemClock } from './domain/clock.js';
import { BrokerError, NotFoundError, OperationError, ValidationError } from './domain/errors.js';
import type { BrokerId } from './domain/ids.js';
import type { TopicFilter, TopicName } from './domain/topic.js';
import { DiscoveryService } from './discovery/index.js';

import { IngestPipeline } from './ingest/index.js';
import type { Logger, MetricsRecorder } from './observability/index.js';
import { createLogger, noopMetrics } from './observability/index.js';
import type { JsonValue, PayloadViewOptions, SchemaChange, SchemaField } from './payload/index.js';
import { EMPTY_SCHEMA, flattenSchema, schemaChanges, toJsonSchema } from './payload/index.js';
import { createReadPolicy } from './policy/index.js';
import type {
  Answer,
  Limitation,
  MessageFact,
  TopicFacts,
  TopicObservations,
  TopicSummary,
} from './query/index.js';
import {
  coverageLimitations,
  DELIVERED_QOS_LIMITATION,
  recentMessages as readRecentMessages,
  RETAINED_REPLAY_LIMITATION,
  SAMPLED_HISTORY_LIMITATION,
  SCHEMA_TRUNCATED_LIMITATION,
  searchTopics as runSearch,
  toTopicFacts,
  toTopicObservations,
  truncatedResults,
} from './query/index.js';
import type { MessageStore } from './store/index.js';
import { SubscriptionManager } from './subscription/index.js';
import type { TransportFactory, TransportOptions } from './transport/index.js';
import { MqttJsTransportFactory } from './transport/mqttjs/adapter.js';

export interface EngineDependencies {
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly metrics?: MetricsRecorder;
  readonly transportFactory?: TransportFactory;
  readonly catalog?: TopicCatalog;
  readonly messageStore?: MessageStore;
}

export interface OperationOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: { readonly message: string; readonly ratio?: number }) => void;
}

export interface BrokerReport {
  readonly brokerId: BrokerId;
  readonly url: string;
  readonly protocolVersion: 4 | 5;
  readonly status: BrokerStatus;
  readonly tls: { readonly enabled: boolean; readonly mutual: boolean; readonly verified: boolean };
  readonly discovery: ObservationCoverage;
}

export interface DiscoverRequest {
  readonly brokerId?: BrokerId;
  /** Seconds to keep watching before answering. Clamped by configuration. */
  readonly waitSeconds?: number;
}

export interface DiscoverFacts {
  readonly brokerId: BrokerId;
  readonly topicCount: number;
  /** Topics first seen during the wait, which says whether waiting longer would help. */
  readonly topicsDiscoveredWhileWaiting: number;
  readonly messageCount: number;
  readonly waitedMs: number;
  readonly topLevels: readonly { readonly segment: string; readonly topicCount: number }[];
}

export interface TopicTreeRequest {
  readonly brokerId?: BrokerId;
  readonly root?: readonly string[];
  readonly depth?: number;
  readonly maxChildren?: number;
  /** Fold sibling branches whose names differ only in a number or an identifier. */
  readonly foldPatterns?: boolean;
}

export interface SearchTopicsRequest {
  readonly brokerId?: BrokerId;
  readonly filter?: TopicFilter;
  readonly text?: string;
  /**
   * Durations rather than instants, because the engine owns the clock.
   *
   * An adapter that turned "the last minute" into an instant would have to read a clock of
   * its own, and any engine not running on the system clock — a test, a replay — would then
   * be asked about a moment it has never been at.
   */
  readonly activeWithinMs?: number;
  readonly silentForMs?: number;
  /** Only topics this server first saw within the last N milliseconds. */
  readonly firstSeenWithinMs?: number;
  readonly sortBy?: TopicQuery['sortBy'];
  readonly descending?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SearchTopicsFacts {
  readonly topics: readonly TopicSummary[];
  readonly nextCursor?: string;
}

export interface DescribeTopicRequest {
  readonly brokerId?: BrokerId;
  readonly topic: TopicName;
}

export interface InferSchemaRequest {
  readonly brokerId?: BrokerId;
  readonly topic: TopicName;
}

export interface InferSchemaFacts {
  readonly brokerId: BrokerId;
  readonly topic: TopicName;
  /** Payloads folded into the shape. Ingestion samples, so this is not the message count. */
  readonly payloadsInspected: number;
  readonly messageCount: number;
  /** JSON Schema draft 2020-12, ready to export.*/
  readonly jsonSchema: JsonValue;
  readonly fields: readonly SchemaField[];
  /** Positions whose observation window does not match the topic's. */
  readonly changes: readonly SchemaChange[];
  readonly truncated: boolean;
}

export interface RecentMessagesRequest {
  readonly brokerId?: BrokerId;
  readonly topic: TopicName;
  readonly limit?: number;
}

export interface RecentMessagesFacts {
  readonly brokerId: BrokerId;
  readonly topic: TopicName;
  readonly messages: readonly MessageFact[];
}

export interface Engine {
  /** Connects the brokers configured to connect at start-up, and starts their discovery. */
  start(): Promise<void>;
  close(): Promise<void>;
  listBrokers(): Promise<readonly BrokerReport[]>;
  discover(request?: DiscoverRequest, options?: OperationOptions): Promise<Answer<DiscoverFacts>>;
  topicTree(request?: TopicTreeRequest): Promise<Answer<TopicTreeNode>>;
  searchTopics(request?: SearchTopicsRequest): Promise<Answer<SearchTopicsFacts>>;
  describeTopic(request: DescribeTopicRequest): Promise<Answer<TopicFacts, TopicObservations>>;
  recentMessages(request: RecentMessagesRequest): Promise<Answer<RecentMessagesFacts>>;
  /** The shape of a topic's JSON payloads, as JSON Schema and as a flat field list. */
  inferSchema(request: InferSchemaRequest): Promise<Answer<InferSchemaFacts>>;
}

/** Everything one broker needs, assembled once. */
interface BrokerRuntime {
  readonly config: BrokerConfig;
  readonly connection: BrokerConnection;
  readonly subscriptions: SubscriptionManager;
  readonly pipeline: IngestPipeline;
  readonly discovery: DiscoveryService;
}

const PROGRESS_SLICE_MS = 250;

function toTransportOptions(broker: BrokerConfig): TransportOptions {
  const clientId =
    broker.clientId.kind === 'fixed'
      ? broker.clientId.value
      : // A random suffix, because a client id colliding with a device's disconnects that
        // device: the broker closes the older session.
        `${broker.clientId.prefix}-${Math.random().toString(16).slice(2, 10)}`;

  return {
    url: broker.url,
    protocolVersion: broker.protocolVersion,
    clientId,
    ...(broker.auth?.username === undefined ? {} : { username: broker.auth.username }),
    ...(broker.auth?.password === undefined ? {} : { password: broker.auth.password }),
    ...(broker.tls === undefined ? {} : { tls: broker.tls }),
    keepaliveSeconds: broker.timeouts.keepaliveSeconds,
    connectTimeoutMs: broker.timeouts.connectMs,
  };
}

class EngineImplementation implements Engine {
  readonly #config: EngineConfig;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #catalog: TopicCatalog;
  readonly #messageStore: MessageStore;
  readonly #registry: BrokerRegistry;
  readonly #runtimes = new Map<BrokerId, BrokerRuntime>();
  #closed = false;

  constructor(config: EngineConfig, dependencies: EngineDependencies = {}) {
    this.#config = config;
    this.#clock = dependencies.clock ?? systemClock;
    this.#logger =
      dependencies.logger ??
      createLogger({
        level: config.logging.level,
        format: config.logging.format,
        clock: this.#clock,
        redactKeys: config.security.redaction.jsonKeys,
      });
    this.#catalog =
      dependencies.catalog ??
      new MemoryTopicCatalog({
        maxTopicsPerBroker: config.limits.maxTopicsPerBroker,
        onTopicLimit: config.limits.onTopicLimit,
        maxLimit: config.mcp.maxResultItems,
      });
    this.#messageStore =
      dependencies.messageStore ??
      new MemoryMessageStore({
        messagesPerTopic: config.limits.recentMessagesPerTopic,
        maxBytes: config.limits.messageStoreMaxBytes,
        maxLimit: config.mcp.maxResultItems,
      });

    const metrics = dependencies.metrics ?? noopMetrics;
    const transportFactory = dependencies.transportFactory ?? new MqttJsTransportFactory();

    const brokerOptions = [...config.brokers.values()].map((broker) => ({
      brokerId: broker.id,
      transport: toTransportOptions(broker),
      reconnect: broker.reconnect,
    }));

    this.#registry = new BrokerRegistry(brokerOptions, {
      transportFactory,
      clock: this.#clock,
      logger: this.#logger,
      metrics,
      onMessage: (brokerId, message) => {
        this.#runtimes.get(brokerId)?.pipeline.accept(message);
      },
    });

    for (const broker of config.brokers.values()) {
      const connection = this.#registry.resolve(broker.id);
      const policy = createReadPolicy(broker.readPolicy);
      const pipeline = new IngestPipeline({
        brokerId: broker.id,
        policy,
        catalog: this.#catalog,
        messageStore: this.#messageStore,
        clock: this.#clock,
        logger: this.#logger,
        metrics,
        limits: {
          maxInspectBytes: config.limits.maxInspectBytes,
          maxStoredPayloadBytes: config.limits.maxStoredPayloadBytes,
          pendingPayloadMaxBytes: config.limits.pendingPayloadMaxBytes,
          flushIntervalMs: config.limits.flushIntervalMs,
          inspectionsPerFlush: config.limits.inspectionsPerFlush,
          maxTrackedTopics: config.limits.maxTopicsPerBroker,
        },
      });
      const subscriptions = new SubscriptionManager({
        connection,
        policy,
        logger: this.#logger,
        metrics,
      });
      const discovery = new DiscoveryService({
        connection,
        subscriptions,
        catalog: this.#catalog,
        pipeline,
        clock: this.#clock,
        logger: this.#logger,
      });

      this.#runtimes.set(broker.id, {
        config: broker,
        connection,
        subscriptions,
        pipeline,
        discovery,
      });
    }
  }

  async start(): Promise<void> {
    for (const runtime of this.#runtimes.values()) {
      if (runtime.config.connect !== 'startup') {
        continue;
      }
      try {
        await this.#ensureObserving(runtime);
      } catch (error) {
        // One broker refusing credentials must not stop the others, nor the server.
        this.#logger.warn('A broker could not be started', {
          broker: runtime.config.id,
          error,
        });
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const runtime of this.#runtimes.values()) {
      await runtime.discovery.stop();
      await runtime.subscriptions.close();
    }
    await this.#registry.closeAll();
  }

  async listBrokers(): Promise<readonly BrokerReport[]> {
    const reports: BrokerReport[] = [];
    for (const runtime of this.#runtimes.values()) {
      reports.push({
        brokerId: runtime.config.id,
        url: runtime.config.url,
        protocolVersion: runtime.config.protocolVersion,
        status: runtime.connection.status,
        tls: {
          enabled: runtime.config.tls !== undefined,
          mutual: runtime.config.tls?.cert !== undefined,
          verified: runtime.config.tls?.rejectUnauthorized ?? true,
        },
        discovery: await runtime.discovery.coverage(),
      });
    }
    return reports;
  }

  async discover(
    request: DiscoverRequest = {},
    options: OperationOptions = {},
  ): Promise<Answer<DiscoverFacts>> {
    const runtime = this.#resolve(request.brokerId);
    await this.#ensureObserving(runtime);

    const before = await this.#catalog.stats(runtime.config.id);
    const waitedMs = await this.#wait(request.waitSeconds ?? 0, options);
    const after = await this.#catalog.stats(runtime.config.id);

    const tree = await this.#catalog.tree({ brokerId: runtime.config.id, depth: 1 });
    const coverage = await runtime.discovery.coverage();

    return {
      facts: {
        brokerId: runtime.config.id,
        topicCount: after.topicCount,
        topicsDiscoveredWhileWaiting: Math.max(0, after.topicCount - before.topicCount),
        messageCount: after.messageCount,
        waitedMs,
        topLevels: tree.children.map((child) => ({
          segment: child.segment,
          topicCount: child.topicCount,
        })),
      },
      coverage,
      limitations: coverageLimitations(coverage),
    };
  }

  async topicTree(request: TopicTreeRequest = {}): Promise<Answer<TopicTreeNode>> {
    const runtime = this.#resolve(request.brokerId);
    const tree = await this.#catalog.tree({
      brokerId: runtime.config.id,
      ...(request.root === undefined ? {} : { root: request.root }),
      ...(request.depth === undefined ? {} : { depth: request.depth }),
      ...(request.maxChildren === undefined ? {} : { maxChildren: request.maxChildren }),
      ...(request.foldPatterns === undefined ? {} : { foldPatterns: request.foldPatterns }),
    });
    const coverage = await runtime.discovery.coverage();

    return { facts: tree, coverage, limitations: coverageLimitations(coverage) };
  }

  async searchTopics(request: SearchTopicsRequest = {}): Promise<Answer<SearchTopicsFacts>> {
    const runtime = this.#resolve(request.brokerId);
    const now = this.#clock.now();
    const { page, summaries } = await runSearch(
      this.#catalog,
      {
        brokerId: runtime.config.id,
        ...(request.filter === undefined ? {} : { filter: request.filter }),
        ...(request.text === undefined ? {} : { text: request.text }),
        ...(request.activeWithinMs === undefined
          ? {}
          : { activeSince: now - request.activeWithinMs }),
        ...(request.silentForMs === undefined ? {} : { silentSince: now - request.silentForMs }),
        ...(request.firstSeenWithinMs === undefined
          ? {}
          : { firstSeenSince: now - request.firstSeenWithinMs }),
        ...(request.sortBy === undefined ? {} : { sortBy: request.sortBy }),
        ...(request.descending === undefined ? {} : { descending: request.descending }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      },
      now,
    );
    const coverage = await runtime.discovery.coverage();
    const limitations = coverageLimitations(coverage);
    if (page.nextCursor !== undefined) {
      limitations.push(truncatedResults(summaries.length, coverage.topicCount));
    }

    return {
      facts: {
        topics: summaries,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      },
      coverage,
      limitations,
    };
  }

  async describeTopic(
    request: DescribeTopicRequest,
  ): Promise<Answer<TopicFacts, TopicObservations>> {
    const runtime = this.#resolve(request.brokerId);
    const record = await this.#catalog.get(runtime.config.id, request.topic);
    if (record === undefined) {
      throw new NotFoundError(
        'TOPIC_NOT_OBSERVED',
        `No message has been observed on "${request.topic}" for broker "${runtime.config.id}". It may still exist: discovery only sees what is published while it is watching.`,
        { details: { broker: runtime.config.id } },
      );
    }

    const [lastMessage] = await this.#messageStore.recent(runtime.config.id, request.topic, 1);
    const now = this.#clock.now();
    const coverage = await runtime.discovery.coverage();
    const limitations = coverageLimitations(coverage);
    limitations.push(DELIVERED_QOS_LIMITATION);
    if (record.retainedReplayCount > 0) {
      limitations.push(RETAINED_REPLAY_LIMITATION);
    }
    if (record.inspectedCount < record.messageCount) {
      limitations.push(SAMPLED_HISTORY_LIMITATION);
    }

    return {
      facts: toTopicFacts(record, lastMessage, this.#viewOptions()),
      observations: toTopicObservations(record, now),
      coverage,
      limitations,
    };
  }

  async inferSchema(request: InferSchemaRequest): Promise<Answer<InferSchemaFacts>> {
    const runtime = this.#resolve(request.brokerId);
    const record = await this.#catalog.get(runtime.config.id, request.topic);
    if (record === undefined) {
      throw new NotFoundError(
        'TOPIC_NOT_OBSERVED',
        `No message has been observed on "${request.topic}" for broker "${runtime.config.id}". It may still exist: discovery only sees what is published while it is watching.`,
        { details: { broker: runtime.config.id } },
      );
    }

    const schema = record.schema ?? EMPTY_SCHEMA;
    const coverage = await runtime.discovery.coverage();
    const limitations = coverageLimitations(coverage);
    // A shape inferred from a sample is a summary of what was seen, never a contract, and
    // the number of payloads behind it is what tells a reader how much to trust it.
    if (record.inspectedCount < record.messageCount) {
      limitations.push(SAMPLED_HISTORY_LIMITATION);
    }
    if (schema.truncated === true) {
      limitations.push(SCHEMA_TRUNCATED_LIMITATION);
    }

    return {
      facts: {
        brokerId: runtime.config.id,
        topic: request.topic,
        payloadsInspected: schema.seen,
        messageCount: record.messageCount,
        jsonSchema: toJsonSchema(schema),
        fields: flattenSchema(schema),
        changes: schemaChanges(schema),
        truncated: schema.truncated === true,
      },
      coverage,
      limitations,
    };
  }

  async recentMessages(request: RecentMessagesRequest): Promise<Answer<RecentMessagesFacts>> {
    const runtime = this.#resolve(request.brokerId);
    const limit = Math.min(request.limit ?? 5, this.#config.mcp.maxResultItems);
    const messages = await readRecentMessages(
      this.#messageStore,
      runtime.config.id,
      request.topic,
      limit,
      this.#viewOptions(),
    );
    const coverage = await runtime.discovery.coverage();
    const limitations: Limitation[] = [
      ...coverageLimitations(coverage),
      SAMPLED_HISTORY_LIMITATION,
    ];
    if (messages.some((message) => message.retainedReplay)) {
      limitations.push(RETAINED_REPLAY_LIMITATION);
    }

    return {
      facts: { brokerId: runtime.config.id, topic: request.topic, messages },
      coverage,
      limitations,
    };
  }

  #viewOptions(): PayloadViewOptions {
    return {
      maxInspectBytes: this.#config.limits.maxInspectBytes,
      maxTextChars: this.#config.mcp.maxPayloadPreviewChars,
      redactKeys: this.#config.security.redaction.jsonKeys,
    };
  }

  #resolve(brokerId: BrokerId | undefined): BrokerRuntime {
    if (this.#closed) {
      throw new BrokerError('BROKER_UNAVAILABLE', 'The engine is closed.');
    }
    // The registry owns the "which broker did you mean?" answer.
    const connection = this.#registry.resolve(brokerId);
    const runtime = this.#runtimes.get(connection.brokerId);
    if (runtime === undefined) {
      /* v8 ignore next 2 -- runtimes and registry are built from the same configuration */
      throw new BrokerError('BROKER_NOT_FOUND', `Unknown broker "${String(brokerId)}".`);
    }
    return runtime;
  }

  /** Connects and starts discovery if it is not already running. */
  async #ensureObserving(runtime: BrokerRuntime): Promise<void> {
    await runtime.connection.ensureConnected();
    if (runtime.discovery.started || !runtime.config.discovery.enabled) {
      return;
    }
    await runtime.discovery.start({
      filters: runtime.config.discovery.filters,
      includeSysTopics: runtime.config.discovery.includeSysTopics,
      subscriptionQos: runtime.config.discovery.subscriptionQos,
    });
  }

  /**
   * Waits, in slices, so progress can be reported and cancellation honoured.
   *
   * Discovery answers get better with time, but a tool call that blocks for a minute is
   * worse than a short answer that says the window was short.
   */
  async #wait(requestedSeconds: number, options: OperationOptions): Promise<number> {
    const seconds = Math.max(
      0,
      Math.min(requestedSeconds, this.#config.mcp.discoverMaxWaitSeconds),
    );
    if (seconds === 0) {
      return 0;
    }
    if (!Number.isFinite(seconds)) {
      throw new ValidationError('INVALID_ARGUMENT', 'waitSeconds must be a finite number.');
    }

    const totalMs = seconds * 1000;
    const startedAt = this.#clock.monotonic();
    let elapsed = 0;

    while (elapsed < totalMs) {
      if (options.signal?.aborted === true) {
        throw new OperationError('CANCELLED', 'Discovery wait was cancelled.');
      }
      const slice = Math.min(PROGRESS_SLICE_MS, totalMs - elapsed);
      await this.#clock.sleep(slice, options.signal);
      elapsed = this.#clock.monotonic() - startedAt;
      options.onProgress?.({
        message: `Observing… ${String(Math.round(elapsed / 1000))} s of ${String(seconds)} s`,
        ratio: Math.min(1, elapsed / totalMs),
      });
    }
    return elapsed;
  }
}

export function createEngine(config: EngineConfig, dependencies?: EngineDependencies): Engine {
  return new EngineImplementation(config, dependencies);
}

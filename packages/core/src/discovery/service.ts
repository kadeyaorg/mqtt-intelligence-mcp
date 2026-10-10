/**
 * Passive discovery, and the honesty that must come with it (ADR-0007, ADR-0011).
 *
 * MQTT has no way to list topics, so the only portable answer is to subscribe and watch. That
 * makes every answer an answer about a **window**: a topic publishing once a day is invisible
 * after five minutes of observation, a broker may refuse a subtree, and nothing at all is
 * seen while disconnected.
 *
 * So this service does two things. It holds the subscriptions discovery needs, and it keeps
 * the record of what it was actually able to see — since when, through which filters, which
 * ones were refused, when it was disconnected, and what had to be dropped. That record
 * travels with every answer, so "not observed" is never presented as "does not exist".
 */
import type { CatalogStats, TopicCatalog } from '../catalog/index.js';
import type { Clock } from '../domain/clock.js';
import { systemClock } from '../domain/clock.js';
import type { QoS } from '../domain/mqtt.js';
import type { TopicFilter } from '../domain/topic.js';
import { parseTopicFilter } from '../domain/topic.js';
import type { BrokerConnection, BrokerState } from '../broker/index.js';
import type { IngestPipeline } from '../ingest/index.js';
import type { Logger } from '../observability/index.js';
import { noopLogger } from '../observability/index.js';
import type { SubscriptionLease, SubscriptionManager } from '../subscription/index.js';
import type {
  ObservationCoverage,
  ObservationGap,
  RejectedFilterReport,
} from '../domain/coverage.js';

/** `#` never matches a $ tree, so broker-internal topics must be asked for by name. */
export const SYSTEM_TOPIC_FILTER = parseTopicFilter('$SYS/#');

export interface DiscoveryOptions {
  readonly filters: readonly TopicFilter[];
  readonly includeSysTopics?: boolean;
  readonly subscriptionQos?: QoS;
}

export interface DiscoveryServiceDependencies {
  readonly connection: BrokerConnection;
  readonly subscriptions: SubscriptionManager;
  readonly catalog: TopicCatalog;
  readonly pipeline: IngestPipeline;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

/** Keeping every gap of a long-running process would itself be a leak. */
const MAX_TRACKED_GAPS = 20;

export class DiscoveryService {
  readonly #connection: BrokerConnection;
  readonly #subscriptions: SubscriptionManager;
  readonly #catalog: TopicCatalog;
  readonly #pipeline: IngestPipeline;
  readonly #clock: Clock;
  readonly #logger: Logger;

  readonly #leases: SubscriptionLease[] = [];
  readonly #gaps: ObservationGap[] = [];
  #observingSince: number | undefined;
  #observedMs = 0;
  #connectedSince: number | undefined;
  #stopWatching: (() => void) | undefined;
  #started = false;

  constructor(dependencies: DiscoveryServiceDependencies) {
    this.#connection = dependencies.connection;
    this.#subscriptions = dependencies.subscriptions;
    this.#catalog = dependencies.catalog;
    this.#pipeline = dependencies.pipeline;
    this.#clock = dependencies.clock ?? systemClock;
    this.#logger = (dependencies.logger ?? noopLogger).child({
      broker: dependencies.connection.brokerId,
      component: 'discovery',
    });
  }

  get started(): boolean {
    return this.#started;
  }

  /**
   * Starts observing.
   *
   * A filter the policy or the broker refuses does not stop the others: discovery runs with
   * what it can see, and records what it cannot.
   */
  async start(options: DiscoveryOptions): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;

    const filters =
      options.includeSysTopics === true
        ? [...options.filters, SYSTEM_TOPIC_FILTER]
        : options.filters;

    for (const filter of filters) {
      try {
        const lease = await this.#subscriptions.acquire({
          filter,
          qos: options.subscriptionQos ?? 0,
          owner: 'discovery',
        });
        this.#leases.push(lease);
      } catch (error) {
        // Typically ACCESS_DENIED: the policy refused before the broker was asked.
        this.#logger.warn('A discovery filter was refused', { filter, error });
        this.#rejected.push({
          filter,
          reason: error instanceof Error ? error.message : 'refused',
        });
      }
    }

    this.#pipeline.start();
    this.#watchConnection();

    const now = this.#clock.now();
    this.#observingSince = now;
    if (this.#connection.status.state === 'connected') {
      this.#connectedSince = now;
    } else {
      this.#gaps.push({ from: now, reason: 'not-started' });
    }
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#stopWatching?.();
    this.#stopWatching = undefined;
    this.#closeCurrentObservationWindow();

    for (const lease of this.#leases) {
      await lease.release();
    }
    this.#leases.length = 0;
    await this.#pipeline.stop();
  }

  /** What discovery was actually able to see, as of now. */
  async coverage(): Promise<ObservationCoverage> {
    const stats: CatalogStats = await this.#catalog.stats(this.#connection.brokerId);
    const counters = this.#pipeline.counters;
    const now = this.#clock.now();
    const observedMs =
      this.#observedMs + (this.#connectedSince === undefined ? 0 : now - this.#connectedSince);

    const rejected: RejectedFilterReport[] = [...this.#rejected];
    for (const lease of this.#leases) {
      for (const rejection of lease.rejected) {
        rejected.push({
          filter: rejection.filter,
          reason: `the broker refused it with reason code ${String(rejection.reasonCode)}`,
        });
      }
    }

    return {
      brokerId: this.#connection.brokerId,
      filters: this.#subscriptions.brokerFilters,
      rejectedFilters: rejected,
      ...(this.#observingSince === undefined ? {} : { observingSince: this.#observingSince }),
      observedMs,
      gaps: [...this.#gaps],
      droppedPayloads: counters.payloadsDropped,
      deniedMessages: counters.denied,
      evictedTopics: stats.evictedTopics,
      ignoredTopics: stats.ignoredTopics,
      topicCount: stats.topicCount,
      messageCount: stats.messageCount,
    };
  }

  readonly #rejected: RejectedFilterReport[] = [];

  #watchConnection(): void {
    this.#stopWatching = this.#connection.onStateChange((status) => {
      this.#onStateChange(status.state);
    });
  }

  /**
   * Turns connection changes into observation windows.
   *
   * This is what lets an agent distinguish "this topic stopped publishing" from "we were not
   * listening", which are the same silence and very different conclusions.
   */
  #onStateChange(state: BrokerState): void {
    const now = this.#clock.now();

    if (state === 'connected') {
      if (this.#connectedSince === undefined) {
        this.#connectedSince = now;
        const open = this.#gaps.at(-1);
        if (open !== undefined && open.to === undefined) {
          this.#gaps[this.#gaps.length - 1] = { ...open, to: now };
        }
      }
      return;
    }

    if (this.#connectedSince !== undefined) {
      this.#observedMs += now - this.#connectedSince;
      this.#connectedSince = undefined;
      this.#gaps.push({ from: now, reason: 'disconnected' });
      while (this.#gaps.length > MAX_TRACKED_GAPS) {
        this.#gaps.shift();
      }
    }
  }

  #closeCurrentObservationWindow(): void {
    if (this.#connectedSince !== undefined) {
      this.#observedMs += this.#clock.now() - this.#connectedSince;
      this.#connectedSince = undefined;
    }
  }
}

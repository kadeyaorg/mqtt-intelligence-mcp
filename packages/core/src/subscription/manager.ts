/**
 * Subscriptions as leases, and the broker-side set as their minimal cover.
 *
 * Several consumers want to observe overlapping parts of the same namespace: discovery holds
 * `#`, a capture wants `factory/line-01/#`, a describe call wants one topic. Subscribing to
 * each of them separately would be wrong twice over: a broker may deliver one message once
 * per matching subscription, which would inflate every count, and dropping one consumer
 * could unsubscribe a tree another still needs.
 *
 * So consumers acquire **leases**, and the manager keeps one **minimal covering set** at the
 * broker: a filter already covered by a broader one is never sent. Leases are also where the
 * read policy is enforced, before a single byte is requested (ADR-0004), and where a broker's
 * refusal is recorded rather than thrown away — an agent that cannot see a subtree must be
 * told, not left reading silence as absence.
 */
import type { TopicFilter, TopicName } from '../domain/topic.js';
import { coversFilter, matchesTopic } from '../domain/topic.js';
import { PolicyError } from '../domain/errors.js';
import type { BrokerConnection } from '../broker/index.js';
import type { Logger, MetricsRecorder } from '../observability/index.js';
import { noopLogger, noopMetrics } from '../observability/index.js';
import type { ReadPolicy } from '../policy/index.js';
import type { QoS, SubscribeOptions } from '../transport/index.js';

export interface LeaseRequest {
  readonly filter: TopicFilter;
  readonly qos: QoS;
  /** Who wants it: `discovery`, `capture:7f3a`. Appears in logs and diagnostics. */
  readonly owner: string;
  readonly retainHandling?: 0 | 1 | 2;
}

export interface RejectedFilter {
  readonly filter: TopicFilter;
  readonly reasonCode: number;
  readonly message?: string;
}

export interface SubscriptionLease {
  readonly id: string;
  readonly owner: string;
  /** What the consumer asked for. */
  readonly filter: TopicFilter;
  /** What is actually subscribed for it, possibly narrowed by the read policy. */
  readonly effectiveFilters: readonly TopicFilter[];
  /** Filters the broker refused, with its reason code. */
  readonly rejected: readonly RejectedFilter[];
  /** Deny rules that overlap: their messages must be dropped at ingest. */
  readonly filteredByDeny: readonly TopicFilter[];
  /** True when at least one filter is subscribed. */
  readonly active: boolean;
  release(): Promise<void>;
}

export interface SubscriptionManagerDependencies {
  readonly connection: BrokerConnection;
  readonly policy: ReadPolicy;
  readonly logger?: Logger;
  readonly metrics?: MetricsRecorder;
}

const ACTIVE_SUBSCRIPTIONS = 'mqtt_intelligence.subscriptions.active';
const REJECTED_SUBSCRIPTIONS = 'mqtt_intelligence.subscriptions.rejected';

interface LeaseRecord {
  readonly id: string;
  readonly request: LeaseRequest;
  effectiveFilters: readonly TopicFilter[];
  rejected: RejectedFilter[];
  readonly filteredByDeny: readonly TopicFilter[];
  released: boolean;
}

/** Drops every filter already covered by another one in the same set. */
export function minimalCover(filters: Iterable<TopicFilter>): readonly TopicFilter[] {
  const unique = [...new Set(filters)];
  return unique.filter(
    (candidate) => !unique.some((other) => other !== candidate && coversFilter(other, candidate)),
  );
}

export class SubscriptionManager {
  readonly #connection: BrokerConnection;
  readonly #policy: ReadPolicy;
  readonly #logger: Logger;
  readonly #activeGauge;
  readonly #rejectedCounter;

  readonly #leases = new Map<string, LeaseRecord>();
  /** Filters currently subscribed at the broker. */
  readonly #subscribed = new Map<TopicFilter, QoS>();
  /** Refusals seen on the current connection, not retried until it is replaced. */
  readonly #refused = new Map<TopicFilter, RejectedFilter>();

  #nextLeaseId = 1;
  /** Serializes reconciliation: two leases must not race the broker-side set. */
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  #stopListening: () => void;

  constructor(dependencies: SubscriptionManagerDependencies) {
    this.#connection = dependencies.connection;
    this.#policy = dependencies.policy;
    this.#logger = (dependencies.logger ?? noopLogger).child({
      broker: dependencies.connection.brokerId,
      component: 'subscriptions',
    });

    const metrics = dependencies.metrics ?? noopMetrics;
    this.#activeGauge = metrics.upDownCounter(ACTIVE_SUBSCRIPTIONS, {
      description: 'Filters currently subscribed at the broker.',
    });
    this.#rejectedCounter = metrics.counter(REJECTED_SUBSCRIPTIONS, {
      description: 'Subscriptions the broker refused.',
    });

    // A new connection has none of our subscriptions: the desired set is the source of
    // truth, and it is reinstated from here rather than by mqtt.js.
    this.#stopListening = this.#connection.onConnected(() => {
      this.#subscribed.clear();
      this.#refused.clear();
      // Reinstating runs in the background: a reconnection must not wait on the broker.
      void this.#enqueue(async () => this.#reconcile());
    });
  }

  /** Filters currently subscribed at the broker, in no particular order. */
  get brokerFilters(): readonly TopicFilter[] {
    return [...this.#subscribed.keys()];
  }

  get leases(): readonly SubscriptionLease[] {
    return [...this.#leases.values()].map((record) => this.#toLease(record));
  }

  /**
   * Acquires a lease, subscribing whatever is missing.
   *
   * Throws `ACCESS_DENIED` when the read policy refuses the filter outright; a filter the
   * broker refuses comes back as a lease that is not active, with the reason code.
   */
  async acquire(request: LeaseRequest): Promise<SubscriptionLease> {
    if (this.#closed) {
      throw new PolicyError('LIMIT_EXCEEDED', 'The subscription manager is closed.');
    }

    const decision = this.#policy.checkSubscribe(request.filter);
    if (decision.outcome === 'denied') {
      throw new PolicyError('ACCESS_DENIED', decision.reason, {
        details: { filter: request.filter, owner: request.owner },
      });
    }
    if (decision.narrowed) {
      this.#logger.info('Narrowed a subscription to what the policy allows', {
        requested: request.filter,
        effective: decision.filters.join(', '),
        owner: request.owner,
      });
    }

    const record: LeaseRecord = {
      id: `lease-${String(this.#nextLeaseId++)}`,
      request,
      effectiveFilters: decision.filters,
      rejected: [],
      filteredByDeny: decision.filteredByDeny,
      released: false,
    };
    this.#leases.set(record.id, record);

    await this.#enqueue(async () => this.#reconcile());
    return this.#toLease(record);
  }

  /** Lease ids whose requested filter matches this topic. */
  matchingLeaseIds(topic: TopicName): readonly string[] {
    const matching: string[] = [];
    for (const record of this.#leases.values()) {
      if (!record.released && matchesTopic(record.request.filter, topic)) {
        matching.push(record.id);
      }
    }
    return matching;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#stopListening();
    for (const record of this.#leases.values()) {
      record.released = true;
    }
    this.#leases.clear();
    await this.#enqueue(async () => this.#reconcile());
  }

  #toLease(record: LeaseRecord): SubscriptionLease {
    const release = async (): Promise<void> => {
      await this.#release(record.id);
    };
    return {
      id: record.id,
      owner: record.request.owner,
      filter: record.request.filter,
      effectiveFilters: record.effectiveFilters,
      rejected: [...record.rejected],
      filteredByDeny: record.filteredByDeny,
      // A lease is served by whichever subscription covers it, not only by its own filter.
      active: record.effectiveFilters.some((filter) => this.#coveredBy(filter) !== undefined),
      release,
    };
  }

  async #release(leaseId: string): Promise<void> {
    const record = this.#leases.get(leaseId);
    if (record === undefined || record.released) {
      return;
    }
    record.released = true;
    this.#leases.delete(leaseId);
    await this.#enqueue(async () => this.#reconcile());
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    this.#queue = this.#queue.then(work, work);
    return this.#queue;
  }

  /**
   * Brings the broker-side set in line with what the leases need.
   *
   * New filters are subscribed **before** redundant ones are dropped, so no tree is ever
   * momentarily unobserved. The reverse order would create a blind window; this order can
   * instead produce a brief overlap, which a broker may answer with a duplicate delivery.
   * That is the lesser evil, and the window is bounded by one round trip.
   */
  async #reconcile(): Promise<void> {
    const desired = minimalCover(
      [...this.#leases.values()]
        .filter((record) => !record.released)
        .flatMap((record) => record.effectiveFilters)
        .filter((filter) => !this.#refused.has(filter)),
    );

    for (const filter of desired) {
      const current = this.#subscribed.get(filter);
      const wanted = this.#qosFor(filter);
      // Re-subscribing the same filter replaces its QoS, which is how a lease asking for
      // more than an existing one gets served.
      if (current === undefined || current < wanted) {
        await this.#subscribe(filter);
      }
    }

    for (const filter of this.brokerFilters) {
      if (!desired.includes(filter)) {
        await this.#unsubscribe(filter);
      }
    }

    this.#refreshRejections();
  }

  async #subscribe(filter: TopicFilter): Promise<void> {
    const qos = this.#qosFor(filter);
    const options: SubscribeOptions = {
      qos,
      // MQTT 5 only: see the publisher's retain flag rather than a replay marker.
      retainAsPublished: true,
    };

    const outcome = await this.#connection.subscribe(filter, options);
    if (!outcome.granted) {
      const rejection: RejectedFilter = {
        filter,
        reasonCode: outcome.reasonCode,
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
      };
      this.#refused.set(filter, rejection);
      this.#rejectedCounter.add(1, {
        broker: this.#connection.brokerId,
        reasonCode: outcome.reasonCode,
      });
      this.#logger.warn('The broker refused a subscription', {
        filter,
        reasonCode: outcome.reasonCode,
      });
      return;
    }

    this.#subscribed.set(filter, qos);
    this.#activeGauge.add(1, { broker: this.#connection.brokerId });
    this.#logger.debug('Subscribed', { filter, grantedQos: outcome.reasonCode });
  }

  async #unsubscribe(filter: TopicFilter): Promise<void> {
    try {
      await this.#connection.unsubscribe(filter);
    } catch (error) {
      // The subscription dies with the connection anyway; a new one starts from the
      // desired set, so a failed unsubscribe is not worth failing a release for.
      this.#logger.debug('Unsubscribing failed', { filter, error });
    }
    this.#subscribed.delete(filter);
    this.#activeGauge.add(-1, { broker: this.#connection.brokerId });
  }

  /** The subscribed filter serving this one, if any. */
  #coveredBy(filter: TopicFilter): TopicFilter | undefined {
    for (const subscribed of this.#subscribed.keys()) {
      if (coversFilter(subscribed, filter)) {
        return subscribed;
      }
    }
    return undefined;
  }

  /**
   * The highest QoS asked by any lease this subscription serves.
   *
   * One subscription serves every lease it covers, and delivered QoS is the minimum of the
   * published and subscribed values, so the subscription must ask for the most demanding
   * lease or that lease would silently get less than it requested.
   */
  #qosFor(filter: TopicFilter): QoS {
    let qos: QoS = 0;
    for (const record of this.#leases.values()) {
      if (record.released) {
        continue;
      }
      const served = record.effectiveFilters.some((effective) => coversFilter(filter, effective));
      if (served && record.request.qos > qos) {
        qos = record.request.qos;
      }
    }
    return qos;
  }

  /** Re-attributes refusals to the leases that asked for them. */
  #refreshRejections(): void {
    for (const record of this.#leases.values()) {
      record.rejected = record.effectiveFilters
        .map((filter) => this.#refused.get(filter))
        .filter((rejection): rejection is RejectedFilter => rejection !== undefined);
    }
  }
}

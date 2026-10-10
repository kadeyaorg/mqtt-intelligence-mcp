/**
 * One broker, one connection, one state machine (ADR-0006).
 *
 * mqtt.js can reconnect on its own, but with a fixed period, no distinction between a
 * network blip and refused credentials, and resubscription we cannot observe. Those
 * distinctions matter here:
 *
 * - **Authentication failures are never retried.** Brokers lock accounts after repeated
 *   failures, and a wrong password will still be wrong in a second.
 * - **Backoff is exponential with full jitter**, so a broker coming back does not meet every
 *   client of the fleet at the same instant.
 * - **Each successful connection is announced**, because subscriptions live elsewhere and
 *   must be reinstated from their own source of truth.
 *
 * Every transition is observable: an agent is told that the engine was disconnected rather
 * than being left to read silence as "nothing was published".
 */
import type { Clock } from '../domain/clock.js';
import { systemClock } from '../domain/clock.js';
import type { ErrorCode } from '../domain/errors.js';
import { BrokerError, describeError, isMqttIntelligenceError } from '../domain/errors.js';
import type { BrokerId } from '../domain/ids.js';
import type { TopicFilter } from '../domain/topic.js';
import type { Logger, MetricsRecorder } from '../observability/index.js';
import { noopLogger, noopMetrics } from '../observability/index.js';
import type {
  ConnectResult,
  DisconnectReason,
  InboundMessage,
  MqttTransport,
  ServerCapabilities,
  SubscribeOptions,
  SubscribeOutcome,
  TransportFactory,
  TransportOptions,
  UnsubscribeOutcome,
} from '../transport/index.js';
import { isNonRetryableConnectReason } from '../transport/index.js';

export type BrokerState =
  'idle' | 'connecting' | 'connected' | 'backoff' | 'failed' | 'closing' | 'closed';

export interface BrokerFailure {
  readonly code: ErrorCode;
  readonly message: string;
  readonly at: number;
}

export interface BrokerStatus {
  readonly brokerId: BrokerId;
  readonly state: BrokerState;
  /** Wall clock of the last state change. */
  readonly since: number;
  /** Consecutive failed attempts; reset by a successful connection. */
  readonly attempts: number;
  readonly connectedSince?: number;
  /** Connections established after the first one. */
  readonly reconnections: number;
  readonly lastFailure?: BrokerFailure;
  /** Set while in backoff. */
  readonly nextAttemptAt?: number;
  readonly capabilities?: ServerCapabilities;
}

export interface ReconnectOptions {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

export interface BrokerConnectionOptions {
  readonly brokerId: BrokerId;
  readonly transport: TransportOptions;
  readonly reconnect: ReconnectOptions;
}

export interface BrokerConnectionDependencies {
  readonly transportFactory: TransportFactory;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly metrics?: MetricsRecorder;
  /** Injectable for deterministic jitter in tests. */
  readonly random?: () => number;
  readonly onMessage?: (brokerId: BrokerId, message: InboundMessage) => void;
}

export type Unsubscribe = () => void;

const CONNECT_DURATION = 'mqtt_intelligence.broker.connect.duration';
const CONNECTIONS = 'mqtt_intelligence.broker.connections';
const RECONNECTIONS = 'mqtt_intelligence.broker.reconnections';

function classifyConnectFailure(error: unknown): { code: ErrorCode; retryable: boolean } {
  if (isMqttIntelligenceError(error)) {
    const code = error.code;
    if (code === 'BROKER_AUTH_FAILED' || code === 'BROKER_TLS_ERROR') {
      return { code, retryable: false };
    }
    if (code === 'TIMEOUT') {
      return { code, retryable: true };
    }
    const reasonCode = error.details['reasonCode'];
    if (typeof reasonCode === 'number' && isNonRetryableConnectReason(reasonCode)) {
      return { code: 'BROKER_CONNECTION_FAILED', retryable: false };
    }
  }
  return { code: 'BROKER_CONNECTION_FAILED', retryable: true };
}

export class BrokerConnection {
  readonly brokerId: BrokerId;

  readonly #options: BrokerConnectionOptions;
  readonly #factory: TransportFactory;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #random: () => number;
  readonly #onMessage: ((brokerId: BrokerId, message: InboundMessage) => void) | undefined;

  readonly #connectDuration;
  readonly #connections;
  readonly #reconnections;

  #state: BrokerState = 'idle';
  #since: number;
  #attempts = 0;
  #successfulConnections = 0;
  #reconnectionCount = 0;
  #connectedSince: number | undefined;
  #lastFailure: BrokerFailure | undefined;
  #nextAttemptAt: number | undefined;
  #capabilities: ServerCapabilities | undefined;

  #transport: MqttTransport | undefined;
  #attempt: Promise<void> | undefined;
  #backoffTimer: { cancel(): void } | undefined;
  #connectionGeneration = 0;

  readonly #stateListeners = new Set<(status: BrokerStatus) => void>();
  readonly #connectedListeners = new Set<() => void>();

  constructor(options: BrokerConnectionOptions, dependencies: BrokerConnectionDependencies) {
    this.brokerId = options.brokerId;
    this.#options = options;
    this.#factory = dependencies.transportFactory;
    this.#clock = dependencies.clock ?? systemClock;
    this.#logger = (dependencies.logger ?? noopLogger).child({ broker: options.brokerId });
    this.#random = dependencies.random ?? Math.random;
    this.#onMessage = dependencies.onMessage;
    this.#since = this.#clock.now();

    const metrics = dependencies.metrics ?? noopMetrics;
    this.#connectDuration = metrics.histogram(CONNECT_DURATION, {
      unit: 'ms',
      description: 'Time taken by one connection attempt.',
    });
    this.#connections = metrics.upDownCounter(CONNECTIONS, {
      description: 'Established broker connections.',
    });
    this.#reconnections = metrics.counter(RECONNECTIONS, {
      description: 'Connections re-established after a loss.',
    });
  }

  get status(): BrokerStatus {
    return {
      brokerId: this.brokerId,
      state: this.#state,
      since: this.#since,
      attempts: this.#attempts,
      reconnections: this.#reconnectionCount,
      ...(this.#connectedSince === undefined ? {} : { connectedSince: this.#connectedSince }),
      ...(this.#lastFailure === undefined ? {} : { lastFailure: this.#lastFailure }),
      ...(this.#nextAttemptAt === undefined ? {} : { nextAttemptAt: this.#nextAttemptAt }),
      ...(this.#capabilities === undefined ? {} : { capabilities: this.#capabilities }),
    };
  }

  onStateChange(listener: (status: BrokerStatus) => void): Unsubscribe {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  /** Called after every successful connection, so subscriptions can be reinstated. */
  onConnected(listener: () => void): Unsubscribe {
    this.#connectedListeners.add(listener);
    return () => this.#connectedListeners.delete(listener);
  }

  /**
   * Resolves once connected.
   *
   * While waiting out a backoff it fails immediately instead of blocking a tool call for up
   * to a minute: the caller is told when the next attempt is due.
   */
  async ensureConnected(): Promise<void> {
    switch (this.#state) {
      case 'connected':
        return;
      case 'connecting':
        await this.#attempt;
        return;
      case 'idle':
        await this.#runAttempt();
        return;
      case 'backoff':
        throw new BrokerError(
          'BROKER_UNAVAILABLE',
          `Broker "${this.brokerId}" is not connected; the next attempt is scheduled.`,
          {
            retryable: true,
            details: {
              broker: this.brokerId,
              attempts: this.#attempts,
              ...(this.#nextAttemptAt === undefined ? {} : { nextAttemptAt: this.#nextAttemptAt }),
            },
          },
        );
      case 'failed':
        throw new BrokerError(
          this.#lastFailure?.code === 'BROKER_AUTH_FAILED'
            ? 'BROKER_AUTH_FAILED'
            : 'BROKER_CONNECTION_FAILED',
          `Broker "${this.brokerId}" cannot be connected: ${this.#lastFailure?.message ?? 'unknown failure'}`,
          { details: { broker: this.brokerId } },
        );
      case 'closing':
      case 'closed':
        throw new BrokerError('BROKER_UNAVAILABLE', `Broker "${this.brokerId}" is shut down.`, {
          details: { broker: this.brokerId },
        });
    }
  }

  /** Leaves `failed` or `backoff` and attempts immediately. */
  async retry(): Promise<void> {
    if (this.#state === 'closing' || this.#state === 'closed') {
      throw new BrokerError('BROKER_UNAVAILABLE', `Broker "${this.brokerId}" is shut down.`, {
        details: { broker: this.brokerId },
      });
    }
    this.#cancelBackoff();
    if (this.#state === 'connected') {
      return;
    }
    if (this.#state === 'connecting') {
      await this.#attempt;
      return;
    }
    await this.#runAttempt();
  }

  async subscribe(filter: TopicFilter, options: SubscribeOptions): Promise<SubscribeOutcome> {
    return (await this.#requireTransport()).subscribe(filter, options);
  }

  async unsubscribe(filter: TopicFilter): Promise<UnsubscribeOutcome> {
    return (await this.#requireTransport()).unsubscribe(filter);
  }

  async close(): Promise<void> {
    if (this.#state === 'closed' || this.#state === 'closing') {
      return;
    }
    this.#setState('closing');
    this.#cancelBackoff();
    this.#connectionGeneration += 1;

    const transport = this.#transport;
    this.#transport = undefined;
    if (transport !== undefined) {
      try {
        await transport.close();
      } catch (error) {
        this.#logger.warn('Closing the transport failed', { error });
      }
    }
    this.#connectedSince = undefined;
    this.#setState('closed');
  }

  async #requireTransport(): Promise<MqttTransport> {
    await this.ensureConnected();
    const transport = this.#transport;
    if (transport === undefined) {
      /* v8 ignore next 4 -- ensureConnected either sets a transport or throws */
      throw new BrokerError('BROKER_UNAVAILABLE', `Broker "${this.brokerId}" is not connected.`, {
        details: { broker: this.brokerId },
      });
    }
    return transport;
  }

  #runAttempt(): Promise<void> {
    const attempt = this.#attemptConnection();
    this.#attempt = attempt;
    return attempt;
  }

  async #attemptConnection(): Promise<void> {
    this.#attempts += 1;
    this.#nextAttemptAt = undefined;
    this.#setState('connecting');

    // Each attempt gets its own identity, so a transport replaced by a later one cannot
    // report a disconnect that would knock the live connection over.
    this.#connectionGeneration += 1;
    const generation = this.#connectionGeneration;
    const startedAt = this.#clock.monotonic();
    const controller = new AbortController();
    const timeout = this.#clock.setTimeout(() => {
      controller.abort();
    }, this.#options.transport.connectTimeoutMs);

    const transport = this.#factory.create(this.#options.transport, {
      onMessage: (message) => {
        if (generation === this.#connectionGeneration) {
          this.#onMessage?.(this.brokerId, message);
        }
      },
      onDisconnect: (reason) => {
        this.#handleDisconnect(generation, reason);
      },
    });

    let result: ConnectResult;
    try {
      result = await transport.connect(controller.signal);
    } catch (error) {
      timeout.cancel();
      await this.#discard(transport);
      this.#recordAttempt(startedAt, 'failure');
      this.#handleConnectFailure(generation, controller.signal.aborted, error);
      throw this.#failureError();
    }
    timeout.cancel();

    if (generation !== this.#connectionGeneration) {
      // close() happened while connecting: do not keep a connection nobody asked for.
      await this.#discard(transport);
      return;
    }

    this.#transport = transport;
    this.#capabilities = result.capabilities;
    this.#attempts = 0;
    this.#lastFailure = undefined;
    this.#connectedSince = this.#clock.now();
    this.#recordAttempt(startedAt, 'success');
    this.#connections.add(1, { broker: this.brokerId });

    if (this.#successfulConnections > 0) {
      this.#reconnectionCount += 1;
      this.#reconnections.add(1, { broker: this.brokerId });
    }
    this.#successfulConnections += 1;

    this.#logger.info('Connected', {
      sessionPresent: result.sessionPresent,
      reconnection: this.#reconnectionCount > 0,
    });
    this.#setState('connected');

    for (const listener of this.#connectedListeners) {
      listener();
    }
  }

  #recordAttempt(startedAt: number, outcome: 'success' | 'failure'): void {
    this.#connectDuration.record(this.#clock.monotonic() - startedAt, {
      broker: this.brokerId,
      outcome,
    });
  }

  #handleConnectFailure(generation: number, aborted: boolean, error: unknown): void {
    if (generation !== this.#connectionGeneration) {
      return;
    }
    const classified = aborted
      ? { code: 'TIMEOUT' as ErrorCode, retryable: true }
      : classifyConnectFailure(error);
    const message = aborted
      ? `Connection attempt timed out after ${String(this.#options.transport.connectTimeoutMs)} ms`
      : describeError(error);

    this.#lastFailure = { code: classified.code, message, at: this.#clock.now() };

    if (classified.retryable) {
      this.#logger.warn('Connection attempt failed', { attempts: this.#attempts, error: message });
      this.#scheduleBackoff();
      return;
    }
    // Retrying refused credentials can lock the account: stop and wait for a human.
    this.#logger.error('Connection refused, not retrying', {
      code: classified.code,
      error: message,
    });
    this.#setState('failed');
  }

  #handleDisconnect(generation: number, reason: DisconnectReason): void {
    if (generation !== this.#connectionGeneration || this.#state !== 'connected') {
      return;
    }
    this.#connections.add(-1, { broker: this.brokerId });
    this.#connectedSince = undefined;
    this.#transport = undefined;
    this.#attempts = 0;
    this.#lastFailure = {
      code: 'BROKER_UNAVAILABLE',
      message: reason.kind === 'client' ? 'closed locally' : reason.message,
      at: this.#clock.now(),
    };
    this.#logger.warn('Connection lost', {
      reason: reason.kind,
      message: this.#lastFailure.message,
    });
    this.#scheduleBackoff();
  }

  #scheduleBackoff(): void {
    const { initialDelayMs, maxDelayMs } = this.#options.reconnect;
    const exponential = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.max(0, this.#attempts - 1));
    // Full jitter: every client of a fleet comes back at a different instant.
    const delay = Math.max(1, Math.round(this.#random() * exponential));

    this.#nextAttemptAt = this.#clock.now() + delay;
    this.#setState('backoff');

    const generation = this.#connectionGeneration;
    this.#backoffTimer = this.#clock.setTimeout(() => {
      this.#backoffTimer = undefined;
      if (generation !== this.#connectionGeneration || this.#state !== 'backoff') {
        return;
      }
      void this.#runAttempt().catch(() => {
        // Already recorded as a failure; the next backoff is scheduled.
      });
    }, delay);
  }

  #cancelBackoff(): void {
    this.#backoffTimer?.cancel();
    this.#backoffTimer = undefined;
    this.#nextAttemptAt = undefined;
  }

  async #discard(transport: MqttTransport): Promise<void> {
    try {
      await transport.close({ force: true });
    } catch (error) {
      this.#logger.debug('Discarding a transport failed', { error });
    }
  }

  #failureError(): BrokerError {
    const failure = this.#lastFailure;
    const code =
      failure?.code === 'BROKER_AUTH_FAILED' ? 'BROKER_AUTH_FAILED' : 'BROKER_CONNECTION_FAILED';
    return new BrokerError(
      code,
      `Broker "${this.brokerId}" could not be connected: ${failure?.message ?? 'unknown failure'}`,
      {
        retryable: this.#state === 'backoff',
        details: { broker: this.brokerId, attempts: this.#attempts },
      },
    );
  }

  #setState(state: BrokerState): void {
    if (this.#state === state) {
      return;
    }
    this.#state = state;
    this.#since = this.#clock.now();
    const status = this.status;
    for (const listener of this.#stateListeners) {
      listener(status);
    }
  }
}

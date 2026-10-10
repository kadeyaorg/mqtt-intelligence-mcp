/**
 * The set of configured brokers (ADR-0005).
 *
 * Connections are independent: one broker refusing credentials, or being unreachable, never
 * stops another from working. Resolving a broker by id is also where the "which broker did
 * you mean?" answer is produced, since an agent omitting it when several are configured is a
 * mistake worth naming rather than guessing.
 */
import { BrokerError } from '../domain/errors.js';
import type { BrokerId } from '../domain/ids.js';
import type {
  BrokerConnectionDependencies,
  BrokerConnectionOptions,
  BrokerStatus,
} from './connection.js';
import { BrokerConnection } from './connection.js';

export class BrokerRegistry {
  readonly #connections = new Map<BrokerId, BrokerConnection>();

  constructor(
    brokers: readonly BrokerConnectionOptions[],
    dependencies: BrokerConnectionDependencies,
  ) {
    for (const options of brokers) {
      this.#connections.set(options.brokerId, new BrokerConnection(options, dependencies));
    }
  }

  get ids(): readonly BrokerId[] {
    return [...this.#connections.keys()];
  }

  get connections(): readonly BrokerConnection[] {
    return [...this.#connections.values()];
  }

  statuses(): readonly BrokerStatus[] {
    return this.connections.map((connection) => connection.status);
  }

  has(brokerId: BrokerId): boolean {
    return this.#connections.has(brokerId);
  }

  /**
   * Resolves a broker, or explains why it cannot.
   *
   * An omitted id works only when exactly one broker is configured: silently picking one of
   * several would let an agent query staging while believing it queried production.
   */
  resolve(brokerId?: BrokerId): BrokerConnection {
    if (brokerId === undefined) {
      const [only] = this.connections;
      if (only === undefined) {
        throw new BrokerError('BROKER_NOT_FOUND', 'No broker is configured.');
      }
      if (this.#connections.size > 1) {
        throw new BrokerError(
          'BROKER_AMBIGUOUS',
          `Several brokers are configured; name one of: ${this.ids.join(', ')}.`,
          { details: { brokers: this.ids.join(', ') } },
        );
      }
      return only;
    }

    const connection = this.#connections.get(brokerId);
    if (connection === undefined) {
      throw new BrokerError(
        'BROKER_NOT_FOUND',
        `Unknown broker "${brokerId}". Configured brokers: ${this.ids.join(', ') || 'none'}.`,
        { details: { broker: brokerId } },
      );
    }
    return connection;
  }

  /** Connects every broker, never letting one failure hide another. */
  async connectAll(brokerIds?: readonly BrokerId[]): Promise<void> {
    const targets =
      brokerIds === undefined
        ? this.connections
        : brokerIds.map((brokerId) => this.resolve(brokerId));

    await Promise.allSettled(targets.map(async (connection) => connection.ensureConnected()));
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(this.connections.map(async (connection) => connection.close()));
  }
}

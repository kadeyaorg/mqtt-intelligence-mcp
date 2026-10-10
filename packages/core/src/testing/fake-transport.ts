/**
 * A scriptable `MqttTransport`, so every failure mode is testable without a broker.
 *
 * Reconnection, backoff and resubscription are decided by code that must behave correctly
 * when a broker refuses credentials, accepts some filters and refuses others, drops the
 * socket mid-stream, or never answers at all. Reproducing that against a real broker is slow
 * and flaky; here it is three lines.
 */
import { parseTopicFilter } from '../domain/topic.js';
import type {
  ConnectResult,
  DisconnectReason,
  InboundMessage,
  MqttTransport,
  SubscribeOptions,
  SubscribeOutcome,
  TransportFactory,
  TransportHandlers,
  TransportOptions,
  UnsubscribeOutcome,
} from '../transport/index.js';

export type ConnectBehaviour =
  | { readonly type: 'success'; readonly result?: ConnectResult }
  | { readonly type: 'fail'; readonly error: Error }
  /** Never answers, until the caller's signal aborts. */
  | { readonly type: 'hang' };

export interface FakeSubscription {
  readonly filter: string;
  readonly options: SubscribeOptions;
}

export class FakeTransport implements MqttTransport {
  readonly options: TransportOptions;
  readonly handlers: TransportHandlers;

  /** What the next `connect()` does. Change it between attempts. */
  connectBehaviour: ConnectBehaviour = { type: 'success' };
  /** Outcomes for specific filters; anything else is granted at the requested QoS. */
  readonly subscribeOutcomes = new Map<string, Omit<SubscribeOutcome, 'filter'>>();

  connectAttempts = 0;
  closeCount = 0;
  forcedCloses = 0;
  connected = false;
  readonly subscriptions: FakeSubscription[] = [];
  readonly unsubscribed: string[] = [];

  constructor(options: TransportOptions, handlers: TransportHandlers) {
    this.options = options;
    this.handlers = handlers;
  }

  async connect(signal?: AbortSignal): Promise<ConnectResult> {
    this.connectAttempts += 1;
    const behaviour = this.connectBehaviour;

    if (behaviour.type === 'fail') {
      throw behaviour.error;
    }
    if (behaviour.type === 'hang') {
      return new Promise<ConnectResult>((_resolve, reject) => {
        if (signal === undefined) {
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            reject(new Error('connect aborted'));
          },
          { once: true },
        );
      });
    }

    this.connected = true;
    return Promise.resolve(behaviour.result ?? { sessionPresent: false });
  }

  subscribe(filter: string, options: SubscribeOptions): Promise<SubscribeOutcome> {
    const scripted = this.subscribeOutcomes.get(filter);
    const outcome: SubscribeOutcome = {
      filter: parseTopicFilter(filter),
      granted: scripted?.granted ?? true,
      reasonCode: scripted?.reasonCode ?? options.qos,
      ...(scripted?.message === undefined ? {} : { message: scripted.message }),
    };
    if (outcome.granted) {
      this.subscriptions.push({ filter, options });
    }
    return Promise.resolve(outcome);
  }

  unsubscribe(filter: string): Promise<UnsubscribeOutcome> {
    this.unsubscribed.push(filter);
    const index = this.subscriptions.findIndex((subscription) => subscription.filter === filter);
    if (index >= 0) {
      this.subscriptions.splice(index, 1);
    }
    return Promise.resolve({ filter: parseTopicFilter(filter), acknowledged: true });
  }

  close(options?: { readonly force?: boolean }): Promise<void> {
    this.closeCount += 1;
    if (options?.force === true) {
      this.forcedCloses += 1;
    }
    this.connected = false;
    return Promise.resolve();
  }

  /** Delivers a message as the broker would. */
  deliver(message: Partial<InboundMessage> & Pick<InboundMessage, 'topic'>): void {
    this.handlers.onMessage({
      payload: new Uint8Array(),
      qos: 0,
      retain: false,
      dup: false,
      ...message,
    });
  }

  /** Drops the connection as a broker or a network would. */
  dropConnection(reason: DisconnectReason = { kind: 'network', message: 'socket closed' }): void {
    this.connected = false;
    this.handlers.onDisconnect(reason);
  }

  /** The filters currently subscribed, in the order they were granted. */
  get subscribedFilters(): readonly string[] {
    return this.subscriptions.map((subscription) => subscription.filter);
  }
}

export class FakeTransportFactory implements TransportFactory {
  readonly created: FakeTransport[] = [];
  /** Applied to every transport this factory creates. */
  connectBehaviour: ConnectBehaviour = { type: 'success' };

  create(options: TransportOptions, handlers: TransportHandlers): FakeTransport {
    const transport = new FakeTransport(options, handlers);
    transport.connectBehaviour = this.connectBehaviour;
    this.created.push(transport);
    return transport;
  }

  /** The transport of the most recent attempt. */
  get last(): FakeTransport {
    const transport = this.created.at(-1);
    if (transport === undefined) {
      throw new Error('No transport has been created yet.');
    }
    return transport;
  }
}

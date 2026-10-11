/**
 * The mqtt.js implementation of the transport port (ADR-0006).
 *
 * This is the only file in the engine allowed to import mqtt.js, which is why the awkward
 * parts of that library are handled here rather than spreading:
 *
 * - `connectAsync` can wait through retries without settling, so each attempt is driven
 *   manually with `manualConnect` and resolved on the first of connect, error or close;
 * - `subscribeAsync` rejects the whole call when any filter is refused, so filters are sent
 *   one per call and a refusal is returned as an outcome, not thrown;
 * - the `message` event has no backpressure, so the handler must stay cheap: holding it also
 *   holds PINGRESP processing, which gets the client disconnected (upstream #1935, #2026).
 */
import mqtt from 'mqtt';
import type { IClientSubscribeOptions, MqttClient } from 'mqtt';
import { BrokerError, describeError, OperationError } from '../../domain/errors.js';
import type { TopicFilter } from '../../domain/topic.js';
import type {
  ConnectResult,
  DisconnectReason,
  InboundMessage,
  InboundMessageProperties,
  MqttTransport,
  QoS,
  ServerCapabilities,
  SubscribeOptions,
  SubscribeOutcome,
  TransportFactory,
  TransportHandlers,
  TransportOptions,
  UnsubscribeOutcome,
} from '../port.js';
import { isNonRetryableConnectReason } from '../port.js';
import { toClientOptions } from './options.js';

/** Bounds what we copy out of a packet, since user properties come from devices. */
const MAX_USER_PROPERTIES = 16;
const MAX_USER_PROPERTY_LENGTH = 256;

interface ConnackLike {
  readonly sessionPresent?: boolean;
  readonly returnCode?: number;
  readonly reasonCode?: number;
  readonly properties?: Record<string, unknown>;
}

function readNumber(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' ? value : undefined;
}

function readBoolean(
  source: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Builds objects whose optional properties are simply absent, not set to undefined. */
type Draft<T> = { -readonly [K in keyof T]?: T[K] };

function assign<T, K extends keyof T>(draft: Draft<T>, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    draft[key] = value;
  }
}

function toCapabilities(
  properties: Record<string, unknown> | undefined,
): ServerCapabilities | undefined {
  if (properties === undefined) {
    return undefined;
  }
  const draft: Draft<ServerCapabilities> = {};
  assign(draft, 'receiveMaximum', readNumber(properties, 'receiveMaximum'));
  assign(draft, 'maximumPacketSize', readNumber(properties, 'maximumPacketSize'));
  assign(draft, 'retainAvailable', readBoolean(properties, 'retainAvailable'));
  assign(
    draft,
    'wildcardSubscriptionAvailable',
    readBoolean(properties, 'wildcardSubscriptionAvailable'),
  );
  assign(
    draft,
    'sharedSubscriptionAvailable',
    readBoolean(properties, 'sharedSubscriptionAvailable'),
  );

  const maximumQoS = readNumber(properties, 'maximumQoS');
  if (maximumQoS === 0 || maximumQoS === 1 || maximumQoS === 2) {
    draft.maximumQoS = maximumQoS;
  }
  return Object.keys(draft).length === 0 ? undefined : draft;
}

function toUserProperties(
  properties: Record<string, unknown> | undefined,
): readonly (readonly [string, string])[] | undefined {
  const raw = properties?.['userProperties'];
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const entries: (readonly [string, string])[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (entries.length >= MAX_USER_PROPERTIES) {
      break;
    }
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item === 'string' && entries.length < MAX_USER_PROPERTIES) {
        entries.push([
          key.slice(0, MAX_USER_PROPERTY_LENGTH),
          item.slice(0, MAX_USER_PROPERTY_LENGTH),
        ]);
      }
    }
  }
  return entries.length === 0 ? undefined : entries;
}

function toMessageProperties(
  properties: Record<string, unknown> | undefined,
): InboundMessageProperties | undefined {
  if (properties === undefined) {
    return undefined;
  }
  const contentType = properties['contentType'];
  const responseTopic = properties['responseTopic'];
  const correlationData = properties['correlationData'];
  const payloadFormatIndicator = properties['payloadFormatIndicator'];

  const draft: Draft<InboundMessageProperties> = {};
  assign(draft, 'contentType', typeof contentType === 'string' ? contentType : undefined);
  assign(draft, 'responseTopic', typeof responseTopic === 'string' ? responseTopic : undefined);
  assign(draft, 'messageExpiryInterval', readNumber(properties, 'messageExpiryInterval'));
  assign(draft, 'userProperties', toUserProperties(properties));
  if (payloadFormatIndicator === true || payloadFormatIndicator === 1) {
    draft.payloadFormatIndicator = 1;
  }
  // Only the size: correlation data is opaque and may carry anything.
  if (correlationData instanceof Uint8Array) {
    draft.correlationDataSize = correlationData.byteLength;
  }
  return Object.keys(draft).length === 0 ? undefined : draft;
}

function connackReasonCode(connack: ConnackLike): number | undefined {
  return connack.reasonCode ?? connack.returnCode;
}

function toConnectError(error: unknown, url: string): BrokerError {
  const message = describeError(error);
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;

  if (typeof code === 'string' && code.startsWith('ERR_TLS')) {
    return new BrokerError('BROKER_TLS_ERROR', `TLS handshake failed: ${message}`, {
      cause: error,
    });
  }
  if (
    typeof code === 'string' &&
    [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
    ].includes(code)
  ) {
    return new BrokerError('BROKER_TLS_ERROR', `Server certificate rejected: ${message}`, {
      cause: error,
    });
  }

  const reasonCode =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number'
      ? error.code
      : undefined;

  if (reasonCode === 0x04 || reasonCode === 0x05 || reasonCode === 0x86 || reasonCode === 0x87) {
    return new BrokerError('BROKER_AUTH_FAILED', `Broker refused the credentials: ${message}`, {
      details: { reasonCode },
      cause: error,
    });
  }
  if (reasonCode !== undefined && isNonRetryableConnectReason(reasonCode)) {
    return new BrokerError(
      'BROKER_CONNECTION_FAILED',
      `Broker refused the connection: ${message}`,
      {
        details: { reasonCode },
        cause: error,
      },
    );
  }
  return new BrokerError('BROKER_CONNECTION_FAILED', `Cannot connect to ${url}: ${message}`, {
    retryable: true,
    cause: error,
  });
}

export class MqttJsTransport implements MqttTransport {
  readonly #options: TransportOptions;
  readonly #handlers: TransportHandlers;
  #client: MqttClient | undefined;
  #disconnectReported = false;

  constructor(options: TransportOptions, handlers: TransportHandlers) {
    this.#options = options;
    this.#handlers = handlers;
  }

  connect(signal?: AbortSignal): Promise<ConnectResult> {
    const client = mqtt.connect(this.#options.url, toClientOptions(this.#options));
    this.#client = client;

    return new Promise<ConnectResult>((resolve, reject) => {
      const settle = (outcome: () => void): void => {
        client.removeListener('connect', onConnect);
        client.removeListener('error', onError);
        client.removeListener('close', onClose);
        signal?.removeEventListener('abort', onAbort);
        outcome();
      };

      const onConnect = (connack: ConnackLike): void => {
        settle(() => {
          this.#attachRuntimeHandlers(client);
          const capabilities = toCapabilities(connack.properties);
          resolve({
            sessionPresent: connack.sessionPresent === true,
            ...(capabilities === undefined ? {} : { capabilities }),
          });
        });
      };

      const onError = (error: Error): void => {
        settle(() => {
          void this.#endQuietly(client);
          reject(toConnectError(error, this.#options.url));
        });
      };

      // A refused CONNACK closes the socket; without this the attempt would hang.
      const onClose = (): void => {
        settle(() => {
          void this.#endQuietly(client);
          reject(
            new BrokerError(
              'BROKER_CONNECTION_FAILED',
              `Connection to ${this.#options.url} closed before CONNACK.`,
              { retryable: true },
            ),
          );
        });
      };

      const onAbort = (): void => {
        settle(() => {
          void this.#endQuietly(client);
          reject(
            new OperationError('TIMEOUT', `Connection attempt to ${this.#options.url} aborted.`),
          );
        });
      };

      client.on('connect', onConnect);
      client.on('error', onError);
      client.on('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });

      client.connect();
    });
  }

  async subscribe(filter: TopicFilter, options: SubscribeOptions): Promise<SubscribeOutcome> {
    const client = this.#requireClient();
    const subscribeOptions: IClientSubscribeOptions = {
      qos: options.qos,
      ...(this.#options.protocolVersion === 5
        ? {
            // Retain As Published defaults to OFF, which is also the protocol default, and
            // changing it back would be a bug rather than an improvement.
            //
            // With it on, the broker forwards the publisher's retain flag on every delivery.
            // That sounds like more information, and it costs the only one that matters: a
            // delivery marked retained is then either a replay at subscribe time or a live
            // publish of a state topic, and nothing distinguishes them. Since replays are
            // excluded from liveness and rate statistics (ADR-0011), every retained state
            // topic — the commonest pattern there is in industrial MQTT — reads as a topic
            // that has never published. Measured against a real production line: 33 of 46
            // actively publishing topics reported "last live never".
            //
            // Off, the flag means what the specification says it means on a forwarded
            // message: this one was replayed at subscribe time. That is exactly the
            // distinction the engine is built on, and it also makes MQTT 5 behave like
            // MQTT 3.1.1, which never had the option.
            rap: options.retainAsPublished ?? false,
            ...(options.retainHandling === undefined ? {} : { rh: options.retainHandling }),
          }
        : {}),
    };

    try {
      const granted = await client.subscribeAsync(filter, subscribeOptions);
      const first = granted[0];
      const reasonCode = first?.qos ?? options.qos;
      return reasonCode >= 0x80
        ? { filter, granted: false, reasonCode, message: 'The broker refused the subscription.' }
        : { filter, granted: true, reasonCode };
    } catch (error) {
      const reasonCode = readSubackReasonCode(error);
      if (reasonCode === undefined) {
        throw new BrokerError(
          'SUBSCRIPTION_REJECTED',
          `Subscribing to "${filter}" failed: ${describeError(error)}`,
          {
            details: { filter },
            cause: error,
          },
        );
      }
      return {
        filter,
        granted: false,
        reasonCode,
        message: describeError(error),
      };
    }
  }

  async unsubscribe(filter: TopicFilter): Promise<UnsubscribeOutcome> {
    const client = this.#requireClient();
    try {
      const packet: unknown = await client.unsubscribeAsync(filter);
      const reasonCode = readFirstGranted(packet);
      return {
        filter,
        acknowledged: reasonCode === undefined || reasonCode < 0x80,
        ...(reasonCode === undefined ? {} : { reasonCode }),
      };
    } catch (error) {
      throw new BrokerError(
        'SUBSCRIPTION_REJECTED',
        `Unsubscribing from "${filter}" failed: ${describeError(error)}`,
        {
          details: { filter },
          cause: error,
        },
      );
    }
  }

  async close(options?: { readonly force?: boolean }): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    if (client === undefined) {
      return;
    }
    // A local close is not a lost connection: do not wake the reconnection logic.
    this.#disconnectReported = true;
    await client.endAsync(options?.force ?? false);
  }

  #attachRuntimeHandlers(client: MqttClient): void {
    client.on('message', (topic: string, payload: Uint8Array, packet: PacketLike) => {
      // Cheap and synchronous: holding this handler also holds keepalive processing.
      this.#handlers.onMessage(toInboundMessage(topic, payload, packet));
    });

    client.on('error', (error) => {
      this.#reportDisconnect({ kind: 'network', message: describeError(error) });
    });
    client.on('close', () => {
      this.#reportDisconnect({ kind: 'network', message: 'connection closed' });
    });
    client.on('disconnect', (packet: ConnackLike) => {
      const reasonCode = connackReasonCode(packet);
      this.#reportDisconnect({
        kind: 'server',
        message: 'the broker sent DISCONNECT',
        ...(reasonCode === undefined ? {} : { reasonCode }),
      });
    });
  }

  #reportDisconnect(reason: DisconnectReason): void {
    if (this.#disconnectReported) {
      return;
    }
    this.#disconnectReported = true;
    this.#handlers.onDisconnect(reason);
  }

  async #endQuietly(client: MqttClient): Promise<void> {
    this.#disconnectReported = true;
    try {
      await client.endAsync(true);
    } catch {
      // The attempt already failed; nothing more to report.
    }
  }

  #requireClient(): MqttClient {
    const client = this.#client;
    if (client === undefined) {
      throw new BrokerError('BROKER_UNAVAILABLE', 'The transport is not connected.');
    }
    return client;
  }
}

interface PacketLike {
  readonly qos?: number;
  readonly retain?: boolean;
  readonly dup?: boolean;
  readonly properties?: Record<string, unknown>;
}

function toInboundMessage(topic: string, payload: Uint8Array, packet: PacketLike): InboundMessage {
  const qos = packet.qos === 1 || packet.qos === 2 ? (packet.qos as QoS) : 0;
  const properties = toMessageProperties(packet.properties);
  return {
    topic,
    payload,
    qos,
    retain: packet.retain === true,
    dup: packet.dup === true,
    ...(properties === undefined ? {} : { properties }),
  };
}

function readFirstGranted(packet: unknown): number | undefined {
  if (typeof packet !== 'object' || packet === null || !('granted' in packet)) {
    return undefined;
  }
  const granted = (packet as { granted?: unknown }).granted;
  if (!Array.isArray(granted)) {
    return undefined;
  }
  const first: unknown = granted[0];
  if (typeof first === 'number') {
    return first;
  }
  if (typeof first === 'object' && first !== null && 'qos' in first) {
    const qos = (first as { qos?: unknown }).qos;
    return typeof qos === 'number' ? qos : undefined;
  }
  return undefined;
}

/** mqtt.js rejects a refused SUBACK with the packet attached. */
function readSubackReasonCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('packet' in error)) {
    return undefined;
  }
  return readFirstGranted((error as { packet?: unknown }).packet);
}

export class MqttJsTransportFactory implements TransportFactory {
  create(options: TransportOptions, handlers: TransportHandlers): MqttTransport {
    return new MqttJsTransport(options, handlers);
  }
}

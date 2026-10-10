/**
 * The `MqttTransport` port (ADR-0006).
 *
 * One transport is one connection attempt at a time: it connects, subscribes, delivers
 * messages and reports that it went away. It does **not** reconnect, does not remember
 * subscriptions and does not retry — those belong to `BrokerConnection` and to the
 * subscription manager, which own the policy decisions.
 *
 * Keeping mqtt.js behind this port buys three things: a fake that makes every failure mode
 * testable without a broker, per-filter subscribe outcomes (mqtt.js rejects a whole batch
 * when one filter is refused), and a single directory to change when mqtt.js v6 lands.
 */
import type { MessageProperties, QoS } from '../domain/mqtt.js';
import type { TopicFilter } from '../domain/topic.js';
import type { Secret } from '../domain/secret.js';

/** Kept as names callers already use; the shapes live in the domain. */
export type InboundMessageProperties = MessageProperties;
export type { QoS };

export interface InboundMessage {
  /** Raw topic as delivered. Validation belongs to the ingest path. */
  readonly topic: string;
  readonly payload: Uint8Array;
  /** Delivered QoS, which is min(publisher QoS, subscription QoS). */
  readonly qos: QoS;
  /** The retain flag as delivered: on MQTT 3.1.1 it marks a replay at subscribe time. */
  readonly retain: boolean;
  readonly dup: boolean;
  readonly properties?: InboundMessageProperties;
}

export type DisconnectReason =
  | { readonly kind: 'network'; readonly message: string }
  | { readonly kind: 'server'; readonly reasonCode?: number; readonly message: string }
  | { readonly kind: 'client' };

/** What the broker said about itself in CONNACK. MQTT 5 only. */
export interface ServerCapabilities {
  readonly receiveMaximum?: number;
  readonly maximumPacketSize?: number;
  readonly maximumQoS?: QoS;
  readonly retainAvailable?: boolean;
  readonly wildcardSubscriptionAvailable?: boolean;
  readonly sharedSubscriptionAvailable?: boolean;
}

export interface ConnectResult {
  readonly sessionPresent: boolean;
  readonly capabilities?: ServerCapabilities;
}

export interface SubscribeOptions {
  readonly qos: QoS;
  /** MQTT 5 `retainAsPublished`: see the publisher's retain flag on live messages. */
  readonly retainAsPublished?: boolean;
  /** MQTT 5 `retainHandling`: 0 send retained, 2 never send them. */
  readonly retainHandling?: 0 | 1 | 2;
}

export interface SubscribeOutcome {
  readonly filter: TopicFilter;
  readonly granted: boolean;
  /** 0, 1 or 2 when granted; 0x80 and above when refused. */
  readonly reasonCode: number;
  readonly message?: string;
}

export interface UnsubscribeOutcome {
  readonly filter: TopicFilter;
  readonly acknowledged: boolean;
  readonly reasonCode?: number;
}

export interface TransportHandlers {
  readonly onMessage: (message: InboundMessage) => void;
  /** Called once when a live connection goes away, for any reason. */
  readonly onDisconnect: (reason: DisconnectReason) => void;
}

export interface TransportTlsOptions {
  readonly ca?: Uint8Array;
  readonly cert?: Uint8Array;
  readonly key?: Secret<Uint8Array>;
  readonly keyPassphrase?: Secret;
  readonly serverName?: string;
  readonly alpn?: readonly string[];
  readonly rejectUnauthorized: boolean;
}

export interface TransportOptions {
  readonly url: string;
  readonly protocolVersion: 4 | 5;
  readonly clientId: string;
  readonly username?: string | Secret;
  readonly password?: Secret;
  readonly tls?: TransportTlsOptions;
  readonly keepaliveSeconds: number;
  readonly connectTimeoutMs: number;
  /** Advertised to the broker so it never sends a packet we would discard anyway. */
  readonly maximumPacketSize?: number;
}

export interface MqttTransport {
  /** One attempt. Resolves on CONNACK success, rejects otherwise. */
  connect(signal?: AbortSignal): Promise<ConnectResult>;
  /** One filter per call, so a refusal names the filter it refused. */
  subscribe(filter: TopicFilter, options: SubscribeOptions): Promise<SubscribeOutcome>;
  unsubscribe(filter: TopicFilter): Promise<UnsubscribeOutcome>;
  /** Ends the connection. `force` skips the DISCONNECT packet. */
  close(options?: { readonly force?: boolean }): Promise<void>;
}

export interface TransportFactory {
  create(options: TransportOptions, handlers: TransportHandlers): MqttTransport;
}

/** Reason codes that mean "these credentials will not work", so retrying is pointless. */
const NON_RETRYABLE_REASON_CODES = new Set([
  0x04, // MQTT 3.1.1: bad user name or password
  0x05, // MQTT 3.1.1: not authorized
  0x85, // MQTT 5: client identifier not valid
  0x86, // MQTT 5: bad user name or password
  0x87, // MQTT 5: not authorized
  0x8c, // MQTT 5: bad authentication method
  0x9a, // MQTT 5: retain not supported
  0x84, // MQTT 5: unsupported protocol version
]);

export function isNonRetryableConnectReason(reasonCode: number | undefined): boolean {
  return reasonCode !== undefined && NON_RETRYABLE_REASON_CODES.has(reasonCode);
}

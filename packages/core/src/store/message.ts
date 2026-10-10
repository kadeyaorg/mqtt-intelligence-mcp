/**
 * An observed message: what the engine keeps of a delivery.
 *
 * Nothing here pretends to be more than it is. `receivedAt` is when **we** received it, not
 * when it was published, because MQTT carries no publish time. `sequence` orders messages
 * that share a millisecond. `deliveredQos` is the minimum of the publisher's and our
 * subscription's. `retainedReplay` marks a message the broker had kept, which is not
 * evidence that anything was published recently.
 *
 * The payload is a **copy**, truncated to the storage limit: keeping a slice of a network
 * buffer would keep the whole buffer alive, and a payload may hold personal data.
 */
import type { BrokerId } from '../domain/ids.js';
import type { TopicName } from '../domain/topic.js';
import type { PayloadClassification } from '../payload/index.js';
import type { MessageProperties, QoS } from '../domain/mqtt.js';

export interface StoredPayload {
  /** Size as published, even when fewer bytes are kept. */
  readonly size: number;
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
  readonly classification: PayloadClassification;
}

export interface ObservedMessage {
  readonly brokerId: BrokerId;
  readonly topic: TopicName;
  /** Receipt time, in epoch milliseconds. Not a publish time. */
  readonly receivedAt: number;
  /** Monotonic within a broker's process lifetime; orders same-millisecond messages. */
  readonly sequence: number;
  readonly deliveredQos: QoS;
  /** The retain flag as delivered. */
  readonly retainFlag: boolean;
  /** True when the broker replayed a retained message at subscribe time. */
  readonly retainedReplay: boolean;
  readonly payload: StoredPayload;
  readonly properties?: MessageProperties;
}

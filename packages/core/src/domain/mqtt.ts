/**
 * Protocol value types shared by everything that handles a message.
 *
 * They live in `domain` rather than in `transport` because they describe MQTT itself, not
 * the act of talking to a broker: the store, the catalog and the query layer all speak about
 * QoS and message properties without knowing a transport exists.
 */

export type QoS = 0 | 1 | 2;

/**
 * MQTT 5 properties carried by a message.
 *
 * They are recorded as facts, never trusted over the bytes: a device announcing
 * `contentType: application/json` can still publish anything (ADR-0010).
 */
export interface MessageProperties {
  readonly contentType?: string;
  readonly payloadFormatIndicator?: 0 | 1;
  readonly messageExpiryInterval?: number;
  readonly responseTopic?: string;
  /** Size only: correlation data is opaque and may carry anything. */
  readonly correlationDataSize?: number;
  readonly userProperties?: readonly (readonly [string, string])[];
}

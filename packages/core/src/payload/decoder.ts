/**
 * Teaching the engine to read payloads it cannot classify.
 *
 * Classification reads bytes and nothing else, so Sparkplug B, protobuf, CBOR and every other
 * framed format all come out as `binary`: a size, a hex preview and a digest. That is the
 * honest answer and a useless one for anyone whose plant speaks Sparkplug.
 *
 * A decoder closes that gap from outside the core. No decoder ships here and none will: each
 * carries a dependency, a schema registry or a specification of its own, and the core stays
 * broker- and format-agnostic (ADR-0002). What lives here is the contract.
 *
 * ## The contract, and why each clause is in it
 *
 * A decoder is **third-party code running on bytes an attacker may have chosen**. So:
 *
 * - **Synchronous.** Decoding happens inside the ingest flush, which is budgeted. A promise
 *   would escape that budget and make the flush unbounded.
 * - **It may throw, and nothing breaks.** Malformed input is normal — half the point of a
 *   decoder is deciding what it cannot read. Throws are caught and counted, and ingestion
 *   carries on; a decoder that throws on every message degrades the answer rather than
 *   stopping the server.
 * - **`undefined` means "not mine".** Returning it is how a decoder declines cheaply, and
 *   declining is what makes a list of decoders work.
 * - **It must not retain the buffer.** The bytes belong to the transport and are reused.
 * - **It must not reach the network.** A decoder that calls a schema registry turns every
 *   message into a request, inside the flush. Fetch what you need before you register.
 *
 * What a decoder returns is treated exactly as parsed JSON would be: bounded, redacted, given
 * a safe view, folded into the topic's inferred shape. The one difference is that the answer
 * always names the decoder, because a reader must never think the bytes were JSON.
 */
import type { JsonValue } from './json.js';

export interface DecodeContext {
  /** The topic the payload arrived on. Many formats key their meaning off it. */
  readonly topic: string;
  /** MQTT 5 `contentType`, when the publisher set one. It is a claim, not proof. */
  readonly contentType?: string;
  /** MQTT 5 user properties, as published. */
  readonly userProperties?: readonly (readonly [string, string])[];
}

export interface PayloadDecoder {
  /**
   * Stable name, reported in every answer a decode produced.
   *
   * It appears in payload views and in payload-kind counts, so changing it changes what
   * readers and dashboards see.
   */
  readonly name: string;
  /** Returns the decoded value, or `undefined` when the payload is not this decoder's. */
  decode(payload: Uint8Array, context: DecodeContext): JsonValue | undefined;
}

export interface DecodeOutcome {
  readonly value: JsonValue;
  readonly decoder: string;
}

export interface DecodeResult {
  readonly outcome?: DecodeOutcome;
  /** Decoders that threw. Counted rather than surfaced: the error is theirs, not the data's. */
  readonly failures: readonly { readonly decoder: string; readonly error: unknown }[];
}

/**
 * Offers a payload to each decoder in turn, first claim wins.
 *
 * Order is the caller's: a decoder list is a priority list, and a decoder that claims
 * everything placed first will starve the rest, which is the caller's business to get right.
 */
export function runDecoders(
  payload: Uint8Array,
  context: DecodeContext,
  decoders: readonly PayloadDecoder[],
): DecodeResult {
  const failures: { decoder: string; error: unknown }[] = [];
  for (const decoder of decoders) {
    try {
      const value = decoder.decode(payload, context);
      if (value !== undefined) {
        return { outcome: { value, decoder: decoder.name }, failures };
      }
    } catch (error) {
      // A decoder that throws is a broken decoder, not a broken payload. Record it and let
      // the next one try: one bad extension must not take a namespace's ingestion with it.
      failures.push({ decoder: decoder.name, error });
    }
  }
  return { failures };
}

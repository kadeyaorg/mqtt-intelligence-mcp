/**
 * Branded identifiers. A brand makes a validated value impossible to confuse with any other
 * string, so a topic name can never be passed where a filter is expected.
 */
import { ValidationError } from './errors.js';

declare const brand: unique symbol;

/** A nominal type: `string` at runtime, distinct at compile time. */
export type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

/**
 * Identifier of a configured broker. Chosen by the operator, never derived from a URL: it
 * appears in prompts, logs and storage keys, and must stay stable when the URL changes
 * (ADR-0005).
 */
export type BrokerId = Brand<string, 'BrokerId'>;

/** Lowercase so `factory-fr` and `Factory-FR` cannot both exist. */
const BROKER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function isBrokerId(value: string): value is BrokerId {
  return BROKER_ID_PATTERN.test(value);
}

export function parseBrokerId(value: string): BrokerId {
  if (!isBrokerId(value)) {
    throw new ValidationError(
      'INVALID_ARGUMENT',
      'Broker id must be 1 to 63 characters, lowercase letters, digits, "-" or "_", starting with a letter or digit.',
      { details: { brokerId: value } },
    );
  }
  return value;
}

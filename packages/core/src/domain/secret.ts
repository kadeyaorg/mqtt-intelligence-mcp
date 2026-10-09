/**
 * Secret values, and the references that produce them (ADR-0013).
 *
 * A secret never appears in configuration files, logs, errors or tool output. The guarantee
 * is enforced by the type rather than by discipline: the value lives in a private field, and
 * every path that stringifies an object — `JSON.stringify`, template literals, `String()`,
 * `util.inspect`, a logger serializing its fields — gets `[REDACTED]` instead.
 *
 * Only the component that actually needs the value calls `reveal()`.
 */
import { REDACTED } from './errors.js';

/** Node's `util.inspect` hook, referenced without importing `node:util`. */
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

export type SecretValue = string | Uint8Array;

export class Secret<Value extends SecretValue = string> {
  readonly #value: Value;

  /** Where the value came from, for diagnostics: `env:MQTT_PASSWORD`, `file:/run/secrets/x`. */
  readonly source: string;

  constructor(value: Value, source: string) {
    this.#value = value;
    this.source = source;
  }

  /** Returns the actual value. Call it as late as possible, and never log the result. */
  reveal(): Value {
    return this.#value;
  }

  /** Length of the secret, useful to diagnose an empty or truncated value. */
  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [INSPECT_CUSTOM](): string {
    return `Secret(${this.source} ${REDACTED})`;
  }
}

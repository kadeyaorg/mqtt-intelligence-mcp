/**
 * Typed errors with stable codes (ADR-0014).
 *
 * Codes are part of the public API: agents branch on them to self-correct, operators read
 * them in logs, library users switch on them. Changing or removing one is a breaking change.
 *
 * Messages and `details` must always be safe to show: no secrets, no credentials. External
 * errors are wrapped with {@link sanitizeError} before they travel anywhere.
 */

/** Configuration could not be loaded, validated or resolved. */
export type ConfigErrorCode = 'CONFIG_INVALID' | 'CONFIG_SECRET_UNRESOLVED';

/** A broker, its connection or one of its subscriptions failed. */
export type BrokerErrorCode =
  | 'BROKER_NOT_FOUND'
  | 'BROKER_AMBIGUOUS'
  | 'BROKER_UNAVAILABLE'
  | 'BROKER_AUTH_FAILED'
  | 'BROKER_TLS_ERROR'
  | 'BROKER_CONNECTION_FAILED'
  | 'SUBSCRIPTION_REJECTED';

/** The security policy or a configured limit refused the operation. */
export type PolicyErrorCode = 'ACCESS_DENIED' | 'LIMIT_EXCEEDED';

/** The caller's input is malformed. */
export type ValidationErrorCode = 'INVALID_TOPIC' | 'INVALID_ARGUMENT';

/** The engine has nothing recorded for what was asked. */
export type NotFoundErrorCode = 'TOPIC_NOT_OBSERVED';

/** The operation did not run to completion. */
export type OperationErrorCode = 'TIMEOUT' | 'CANCELLED';

/** A defect in this library. */
export type InternalErrorCode = 'INTERNAL';

export type ErrorCode =
  | ConfigErrorCode
  | BrokerErrorCode
  | PolicyErrorCode
  | ValidationErrorCode
  | NotFoundErrorCode
  | OperationErrorCode
  | InternalErrorCode;

/** Details are primitives only, so an error is always safe to serialize. */
export type ErrorDetailValue = string | number | boolean;
export type ErrorDetails = Readonly<Record<string, ErrorDetailValue>>;

export interface MqttIntelligenceErrorOptions {
  /** Safe, machine-readable context, for example `{ broker: 'factory-fr' }`. */
  readonly details?: ErrorDetails;
  /** True when retrying the same operation unchanged can reasonably succeed. */
  readonly retryable?: boolean;
  /** The original error. Kept for logs; never rendered to an agent. */
  readonly cause?: unknown;
}

/** Longest message this module produces; longer input is truncated. */
const MAX_MESSAGE_LENGTH = 1024;

export abstract class MqttIntelligenceError extends Error {
  abstract readonly code: ErrorCode;
  readonly details: ErrorDetails;
  readonly retryable: boolean;

  constructor(message: string, options: MqttIntelligenceErrorOptions = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.details = Object.freeze({ ...options.details });
    this.retryable = options.retryable ?? false;
  }
}

export class ConfigError extends MqttIntelligenceError {
  readonly code: ConfigErrorCode;

  constructor(code: ConfigErrorCode, message: string, options?: MqttIntelligenceErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export class BrokerError extends MqttIntelligenceError {
  readonly code: BrokerErrorCode;

  constructor(code: BrokerErrorCode, message: string, options?: MqttIntelligenceErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export class PolicyError extends MqttIntelligenceError {
  readonly code: PolicyErrorCode;

  constructor(code: PolicyErrorCode, message: string, options?: MqttIntelligenceErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export class ValidationError extends MqttIntelligenceError {
  readonly code: ValidationErrorCode;

  constructor(code: ValidationErrorCode, message: string, options?: MqttIntelligenceErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export class NotFoundError extends MqttIntelligenceError {
  readonly code: NotFoundErrorCode;

  constructor(code: NotFoundErrorCode, message: string, options?: MqttIntelligenceErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export class OperationError extends MqttIntelligenceError {
  readonly code: OperationErrorCode;

  constructor(code: OperationErrorCode, message: string, options?: MqttIntelligenceErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** Unlike the other classes there is a single code, so the constructor takes none. */
export class InternalError extends MqttIntelligenceError {
  readonly code: InternalErrorCode = 'INTERNAL';
}

export function isMqttIntelligenceError(value: unknown): value is MqttIntelligenceError {
  return value instanceof MqttIntelligenceError;
}

/** `scheme://user:password@host` and the like. */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;

/**
 * `password=…`, `token: …`, including inside query strings.
 *
 * The value stops at a separator so neighbouring, harmless context survives. An
 * authentication scheme (`Bearer abc`) counts as part of the value, otherwise only the word
 * "Bearer" would be redacted and the token would leak.
 */
const SECRET_ASSIGNMENT =
  /\b(pass|passwd|password|pwd|secret|token|apikey|api_key|authorization|auth|credential|credentials|privatekey|private_key|passphrase)\b(\s*[=:]\s*)((?:bearer|basic|digest)\s+\S+|"[^"]*"|'[^']*'|[^\s,;&)}\]]+)/gi;

export const REDACTED = '[REDACTED]';

/**
 * Removes credentials from free text before it reaches a log, an error message or an agent.
 *
 * Belt and braces: configuration rejects credentials in URLs and keeps secrets in opaque
 * wrappers, but third-party errors quote whatever they were given.
 */
export function redactCredentials(text: string): string {
  return text.replace(URL_USERINFO, `$1${REDACTED}@`).replace(SECRET_ASSIGNMENT, `$1$2${REDACTED}`);
}

function truncate(text: string, maxLength = MAX_MESSAGE_LENGTH): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

/** Best-effort, redacted, bounded description of any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return truncate(redactCredentials(error.message || error.name));
  }
  if (typeof error === 'string') {
    return truncate(redactCredentials(error));
  }
  return `non-error value of type ${typeof error}`;
}

/**
 * Turns anything thrown into one of our errors, so nothing unsanitized escapes the engine.
 *
 * Our own errors pass through untouched; everything else becomes an {@link InternalError}
 * with a redacted message, keeping the original as `cause` for the logs.
 */
export function sanitizeError(
  error: unknown,
  fallbackMessage = 'Unexpected error',
): MqttIntelligenceError {
  if (isMqttIntelligenceError(error)) {
    return error;
  }
  const description = describeError(error);
  const message = description === '' ? fallbackMessage : `${fallbackMessage}: ${description}`;
  const details: ErrorDetails =
    error instanceof Error ? { originalName: error.name } : { originalType: typeof error };
  return new InternalError(message, { cause: error, details });
}

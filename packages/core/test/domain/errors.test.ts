import { describe, expect, it } from 'vitest';
import {
  BrokerError,
  ConfigError,
  describeError,
  InternalError,
  isMqttIntelligenceError,
  MqttIntelligenceError,
  NotFoundError,
  OperationError,
  PolicyError,
  REDACTED,
  redactCredentials,
  sanitizeError,
  ValidationError,
} from '../../src/index.js';

describe('error hierarchy', () => {
  it('carries a stable code, the class name, and the base type', () => {
    const error = new BrokerError('BROKER_AUTH_FAILED', 'Authentication refused.');

    expect(error.code).toBe('BROKER_AUTH_FAILED');
    expect(error.name).toBe('BrokerError');
    expect(error).toBeInstanceOf(MqttIntelligenceError);
    expect(error).toBeInstanceOf(Error);
    expect(isMqttIntelligenceError(error)).toBe(true);
  });

  it('defaults to non-retryable, with empty frozen details', () => {
    const error = new ConfigError('CONFIG_INVALID', 'Broken.');

    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({});
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it('keeps the details, the retryable flag and the cause it was given', () => {
    const cause = new Error('socket hang up');
    const error = new BrokerError('BROKER_UNAVAILABLE', 'Not connected.', {
      details: { broker: 'factory-fr', attempt: 3, final: false },
      retryable: true,
      cause,
    });

    expect(error.details).toEqual({ broker: 'factory-fr', attempt: 3, final: false });
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(cause);
  });

  it.each([
    [new ConfigError('CONFIG_SECRET_UNRESOLVED', 'x'), 'CONFIG_SECRET_UNRESOLVED'],
    [new BrokerError('SUBSCRIPTION_REJECTED', 'x'), 'SUBSCRIPTION_REJECTED'],
    [new PolicyError('ACCESS_DENIED', 'x'), 'ACCESS_DENIED'],
    [new ValidationError('INVALID_ARGUMENT', 'x'), 'INVALID_ARGUMENT'],
    [new NotFoundError('TOPIC_NOT_OBSERVED', 'x'), 'TOPIC_NOT_OBSERVED'],
    [new OperationError('CANCELLED', 'x'), 'CANCELLED'],
    [new InternalError('x'), 'INTERNAL'],
  ])('exposes the code it was constructed with', (error, expectedCode) => {
    expect(error.code).toBe(expectedCode);
  });

  it('is isolated from mutation of the details object it was given', () => {
    const details = { broker: 'factory-fr' };
    const error = new ConfigError('CONFIG_INVALID', 'x', { details });

    details.broker = 'tampered';

    expect(error.details).toEqual({ broker: 'factory-fr' });
  });
});

describe('redactCredentials', () => {
  it.each([
    ['mqtts://alice:s3cret@mqtt.example.com:8883', `mqtts://${REDACTED}@mqtt.example.com:8883`],
    ['mqtt://alice@broker:1883', `mqtt://${REDACTED}@broker:1883`],
    ['password=hunter2', `password=${REDACTED}`],
    ['password: "hunter2"', `password: ${REDACTED}`],
    ['Authorization: Bearer abc.def', `Authorization: ${REDACTED}`],
    ['?token=abc&retain=true', `?token=${REDACTED}&retain=true`],
    ['apiKey = abc123', `apiKey = ${REDACTED}`],
    ['passphrase:abc', `passphrase:${REDACTED}`],
  ])('redacts %s', (input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
  });

  it.each([
    'Connection refused by mqtt.example.com:8883',
    'retain=true, qos=1',
    'factory/line-01/robot/status',
  ])('leaves %s untouched', (input) => {
    expect(redactCredentials(input)).toBe(input);
  });
});

describe('describeError', () => {
  it('redacts the message of an Error', () => {
    const description = describeError(new Error('connect ECONNREFUSED mqtt://bob:pw@host:1883'));

    expect(description).not.toContain('pw');
    expect(description).toContain(REDACTED);
  });

  it('falls back to the name when the message is empty', () => {
    expect(describeError(new TypeError(''))).toBe('TypeError');
  });

  it('handles strings and non-error values', () => {
    expect(describeError('plain failure')).toBe('plain failure');
    expect(describeError(42)).toBe('non-error value of type number');
    expect(describeError(null)).toBe('non-error value of type object');
    expect(describeError(undefined)).toBe('non-error value of type undefined');
  });

  it('bounds the length, so an error cannot flood a log line or an agent context', () => {
    const description = describeError(new Error('x'.repeat(5000)));

    expect(description.length).toBe(1024);
    expect(description.endsWith('…')).toBe(true);
  });
});

describe('sanitizeError', () => {
  it('returns our own errors untouched', () => {
    const error = new PolicyError('ACCESS_DENIED', 'Denied.');

    expect(sanitizeError(error)).toBe(error);
  });

  it('wraps a foreign error, keeping the original as cause', () => {
    const cause = new TypeError('bad socket');
    const wrapped = sanitizeError(cause, 'Transport failed');

    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.code).toBe('INTERNAL');
    expect(wrapped.message).toBe('Transport failed: bad socket');
    expect(wrapped.cause).toBe(cause);
    expect(wrapped.details).toEqual({ originalName: 'TypeError' });
  });

  it('never lets a credential through the wrapped message', () => {
    const wrapped = sanitizeError(new Error('auth failed for mqtts://alice:s3cret@host'));

    expect(wrapped.message).not.toContain('s3cret');
    expect(wrapped.message).toContain(REDACTED);
  });

  it('wraps values that are not errors at all', () => {
    const wrapped = sanitizeError('something broke');

    expect(wrapped.message).toBe('Unexpected error: something broke');
    expect(wrapped.details).toEqual({ originalType: 'string' });
  });
});

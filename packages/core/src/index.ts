/**
 * Public API of the MQTT Intelligence engine (`@kadeya/mqtt-intel-core`).
 *
 * Everything exported from this file is public API under semver. Exports are added step by
 * step, following docs/proposal/05-implementation-plan.md.
 */

export {
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
} from './domain/errors.js';
export type {
  BrokerErrorCode,
  ConfigErrorCode,
  ErrorCode,
  ErrorDetails,
  ErrorDetailValue,
  InternalErrorCode,
  MqttIntelligenceErrorOptions,
  NotFoundErrorCode,
  OperationErrorCode,
  PolicyErrorCode,
  ValidationErrorCode,
} from './domain/errors.js';

export { sleepWithTimer, SystemClock, systemClock } from './domain/clock.js';
export type { Clock, Timer } from './domain/clock.js';

export { isBrokerId, parseBrokerId } from './domain/ids.js';
export type { Brand, BrokerId } from './domain/ids.js';

export {
  coversFilter,
  filtersIntersect,
  isSystemTopic,
  isTopicFilter,
  isTopicName,
  matchesTopic,
  MAX_TOPIC_BYTES,
  MULTI_LEVEL_WILDCARD,
  parseTopicFilter,
  parseTopicName,
  SINGLE_LEVEL_WILDCARD,
  SYSTEM_TOPIC_PREFIX,
  TOPIC_SEPARATOR,
  topicLevels,
} from './domain/topic.js';
export type { TopicFilter, TopicName } from './domain/topic.js';

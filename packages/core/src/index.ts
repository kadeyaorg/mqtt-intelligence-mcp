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

export { createLogger, noopLogger, noopMetrics, sanitizeFields } from './observability/index.js';
export type {
  Counter,
  Histogram,
  Logger,
  LoggerOptions,
  LogFields,
  LogFieldValue,
  LogFormat,
  LogLevel,
  LogSink,
  MetricAttributes,
  MetricAttributeValue,
  MetricOptions,
  MetricsRecorder,
  SafeRecord,
  SafeValue,
  SanitizeOptions,
  UpDownCounter,
} from './observability/index.js';
export type { Clock, Timer } from './domain/clock.js';

export {
  classifyPayload,
  countNodes,
  decodeUtf8,
  DEFAULT_HEX_PREVIEW_BYTES,
  DEFAULT_JSON_LIMITS,
  DEFAULT_MAX_INSPECT_BYTES,
  DEFAULT_MAX_TEXT_CHARS,
  DEFAULT_SCHEMA_LIMITS,
  EMPTY_SCHEMA,
  escapeControlCharacters,
  limitJson,
  looksBinary,
  mergeSchemas,
  observedTypes,
  observeJson,
  toJsonSchema,
  toPayloadView,
} from './payload/index.js';
export type {
  ClassifyOptions,
  JsonLimits,
  JsonObject,
  JsonType,
  JsonValue,
  LimitedJson,
  LimitJsonOptions,
  PayloadClassification,
  PayloadKind,
  PayloadView,
  PayloadViewOptions,
  SchemaLimits,
  SchemaNode,
  SchemaTypeCounts,
  SchemaTypeName,
  UninspectedReason,
} from './payload/index.js';

export { BrokerConnection, BrokerRegistry } from './broker/index.js';
export type {
  BrokerConnectionDependencies,
  BrokerConnectionOptions,
  BrokerFailure,
  BrokerState,
  BrokerStatus,
  ReconnectOptions,
} from './broker/index.js';

export { isNonRetryableConnectReason } from './transport/index.js';
export type {
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
  TransportTlsOptions,
  UnsubscribeOutcome,
} from './transport/index.js';

export { MqttJsTransportFactory } from './transport/mqttjs/adapter.js';

export { minimalCover, SubscriptionManager } from './subscription/index.js';
export type {
  LeaseRequest,
  RejectedFilter,
  SubscriptionLease,
  SubscriptionManagerDependencies,
} from './subscription/index.js';
export {
  applyDelta,
  createRate,
  createRecord,
  decayRate,
  DEFAULT_RATE_TIME_CONSTANT_MS,
  INTERVAL_BUCKET_COUNT,
  intervalBucketOf,
  intervalBucketRange,
  intervalGroups,
  EMPTY_DISTRIBUTION,
  mergeDistributions,
  mergeIntervalBuckets,
  mergeRates,
  mergeRecords,
  observeInterval,
  observeRate,
  observeValue,
  silenceRatio,
  standardDeviation,
  variance,
} from './catalog/index.js';
export type {
  CatalogBatchResult,
  CatalogStats,
  DistributionState,
  IntervalGroup,
  Page,
  PayloadKindCounts,
  QosCounts,
  RateState,
  RetainedState,
  TopicCatalog,
  TopicDelta,
  TopicQuery,
  TopicRecord,
  TopicSortKey,
  TopicTreeNode,
  TreeQuery,
} from './catalog/index.js';

export { MemoryMessageStore, MemoryTopicCatalog } from './store/index.js';
export type {
  MemoryMessageStoreOptions,
  MemoryTopicCatalogOptions,
  MessageQuery,
  MessageStore,
  MessageStoreStats,
  ObservedMessage,
  StoredPayload,
} from './store/index.js';

export type { MessageProperties } from './domain/mqtt.js';

export { DEFAULT_INGEST_LIMITS, IngestPipeline } from './ingest/index.js';
export type { IngestCounters, IngestLimits, IngestPipelineDependencies } from './ingest/index.js';

export { DiscoveryService, SYSTEM_TOPIC_FILTER } from './discovery/index.js';
export type { DiscoveryOptions, DiscoveryServiceDependencies } from './discovery/index.js';

export { createEngine } from './engine.js';
export type {
  BrokerReport,
  DescribeTopicRequest,
  DiscoverFacts,
  DiscoverRequest,
  Engine,
  EngineDependencies,
  OperationOptions,
  RecentMessagesFacts,
  RecentMessagesRequest,
  SearchTopicsFacts,
  SearchTopicsRequest,
  TopicTreeRequest,
} from './engine.js';

export {
  coverageLimitations,
  DELIVERED_QOS_LIMITATION,
  RETAINED_REPLAY_LIMITATION,
  SAMPLED_HISTORY_LIMITATION,
  SHORT_OBSERVATION_MS,
  truncatedResults,
} from './query/index.js';
export type {
  Answer,
  IntervalObservation,
  Limitation,
  LimitationCode,
  MessageFact,
  TopicFacts,
  TopicObservations,
  TopicSummary,
} from './query/index.js';

export { createReadPolicy } from './policy/index.js';
export type { ReadPolicy, ReadRules, SubscribeDecision } from './policy/index.js';

export { isBrokerId, parseBrokerId } from './domain/ids.js';
export type { Brand, BrokerId } from './domain/ids.js';
export type {
  ObservationCoverage,
  ObservationGap,
  RejectedFilterReport,
} from './domain/coverage.js';

export { Secret } from './domain/secret.js';
export type { SecretValue } from './domain/secret.js';
export type { SecretRef } from './config/secret-ref.js';

export { CONFIG_VERSION, configDocumentSchema, DEFAULT_REDACTED_KEYS } from './config/schema.js';
export type { BrokerDocument, ConfigDocument } from './config/schema.js';

export { resolveConfig } from './config/resolve.js';
export type {
  AuthConfig,
  BrokerConfig,
  ClientIdConfig,
  DiscoveryConfig,
  EngineConfig,
  LimitsConfig,
  LoggingConfig,
  McpConfig,
  ReadPolicyConfig,
  RedactionConfig,
  ResolveConfigOptions,
  SecurityConfig,
  StorageConfig,
  TlsConfig,
} from './config/resolve.js';

export {
  buildQuickStartDocument,
  CONFIG_PATH_ENV,
  loadConfig,
  loadConfigFile,
  parseConfigDocument,
  parseConfigText,
  QUICK_START_ENV,
} from './config/load.js';
export type { LoadConfigOptions } from './config/load.js';

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

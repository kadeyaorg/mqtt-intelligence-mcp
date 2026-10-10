export { CONFIG_VERSION, configDocumentSchema, DEFAULT_REDACTED_KEYS } from './schema.js';
export type { BrokerDocument, ConfigDocument } from './schema.js';

export { resolveConfig } from './resolve.js';
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
} from './resolve.js';

export {
  buildQuickStartDocument,
  CONFIG_PATH_ENV,
  loadConfig,
  loadConfigFile,
  parseConfigDocument,
  parseConfigText,
  QUICK_START_ENV,
} from './load.js';
export type { LoadConfigOptions } from './load.js';

export { describeSecretRef, isEnvironmentRef } from './secret-ref.js';
export type { SecretRef } from './secret-ref.js';

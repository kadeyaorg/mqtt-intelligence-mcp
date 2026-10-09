/**
 * Turns a configuration document into the `EngineConfig` the engine runs on.
 *
 * Resolution is where the outside world is touched: environment variables are read, secret
 * files and TLS material are loaded, relative paths are resolved against the configuration
 * file, and the per-broker read policy is computed once and for all. Everything that can
 * fail here fails at start-up, with the exact path of the offending key, rather than on the
 * first message hours later.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { ConfigError, describeError } from '../domain/errors.js';
import type { BrokerId } from '../domain/ids.js';
import type { TopicFilter } from '../domain/topic.js';
import type { BrokerDocument, ConfigDocument } from './schema.js';
import type { SecretRef } from './secret.js';
import { describeSecretRef, isEnvironmentRef, Secret } from './secret.js';

export type LimitsConfig = ConfigDocument['limits'];
export type McpConfig = ConfigDocument['mcp'];
export type StorageConfig = ConfigDocument['storage'];
export type LoggingConfig = ConfigDocument['logging'];

export interface RedactionConfig {
  /** Lowercase JSON keys whose values are replaced in every payload view. */
  readonly jsonKeys: readonly string[];
}

export interface SecurityConfig {
  readonly redaction: RedactionConfig;
  /** Always false in this version; the publish tool is not registered at all. */
  readonly publishEnabled: false;
}

/** The effective read policy of one broker: global rules merged with its own. */
export interface ReadPolicyConfig {
  readonly allow: readonly TopicFilter[];
  readonly deny: readonly TopicFilter[];
}

export type ClientIdConfig =
  | { readonly kind: 'prefix'; readonly prefix: string }
  | { readonly kind: 'fixed'; readonly value: string };

export interface AuthConfig {
  readonly username?: string | Secret;
  readonly password?: Secret;
}

export interface TlsConfig {
  readonly ca?: Uint8Array;
  readonly cert?: Uint8Array;
  readonly key?: Secret<Uint8Array>;
  readonly keyPassphrase?: Secret;
  readonly serverName?: string;
  readonly alpn: readonly string[];
  readonly rejectUnauthorized: boolean;
}

export interface DiscoveryConfig {
  readonly enabled: boolean;
  readonly filters: readonly TopicFilter[];
  readonly includeSysTopics: boolean;
  readonly subscriptionQos: 0 | 1 | 2;
}

export interface BrokerConfig {
  readonly id: BrokerId;
  readonly url: string;
  readonly protocolVersion: 4 | 5;
  readonly clientId: ClientIdConfig;
  readonly connect: 'startup' | 'lazy';
  readonly auth?: AuthConfig;
  readonly tls?: TlsConfig;
  readonly timeouts: BrokerDocument['timeouts'];
  readonly reconnect: BrokerDocument['reconnect'];
  readonly discovery: DiscoveryConfig;
  readonly readPolicy: ReadPolicyConfig;
}

export interface EngineConfig {
  readonly brokers: ReadonlyMap<BrokerId, BrokerConfig>;
  readonly security: SecurityConfig;
  readonly limits: LimitsConfig;
  readonly mcp: McpConfig;
  readonly storage: StorageConfig;
  readonly logging: LoggingConfig;
}

export interface ResolveConfigOptions {
  /** Environment used for `{ env }` references. Defaults to the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Directory relative paths resolve against. Defaults to the current directory. */
  readonly baseDir?: string;
}

interface ResolutionContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly baseDir: string;
}

function unresolved(path: string, reason: string): ConfigError {
  return new ConfigError('CONFIG_SECRET_UNRESOLVED', `${path}: ${reason}`, {
    details: { path },
  });
}

async function readFileAt(
  relativeOrAbsolute: string,
  path: string,
  context: ResolutionContext,
): Promise<Uint8Array> {
  const absolute = isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : resolvePath(context.baseDir, relativeOrAbsolute);
  try {
    return await readFile(absolute);
  } catch (error) {
    const reason =
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? `file not found: ${absolute}`
        : `cannot read ${absolute}: ${describeError(error)}`;
    throw unresolved(path, reason);
  }
}

async function resolveSecret(
  ref: SecretRef,
  path: string,
  context: ResolutionContext,
): Promise<Secret> {
  const source = describeSecretRef(ref);
  if (isEnvironmentRef(ref)) {
    const value = context.env[ref.env];
    if (value === undefined || value === '') {
      throw unresolved(path, `environment variable ${ref.env} is not set, or is empty.`);
    }
    return new Secret(value, source);
  }
  const bytes = await readFileAt(ref.file, path, context);
  // Secret files usually end with a newline that is not part of the secret.
  const value = new TextDecoder().decode(bytes).replace(/\r?\n$/, '');
  if (value === '') {
    throw unresolved(path, `file is empty: ${ref.file}`);
  }
  return new Secret(value, source);
}

async function resolveAuth(
  broker: BrokerDocument,
  path: string,
  context: ResolutionContext,
): Promise<AuthConfig | undefined> {
  const auth = broker.auth;
  if (auth === undefined) {
    return undefined;
  }
  const username =
    auth.username === undefined
      ? undefined
      : typeof auth.username === 'string'
        ? auth.username
        : await resolveSecret(auth.username, `${path}.auth.username`, context);
  const password =
    auth.password === undefined
      ? undefined
      : await resolveSecret(auth.password, `${path}.auth.password`, context);

  return {
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
  };
}

async function resolveTls(
  broker: BrokerDocument,
  path: string,
  context: ResolutionContext,
): Promise<TlsConfig | undefined> {
  const tls = broker.tls;
  if (tls === undefined) {
    return undefined;
  }
  const ca =
    tls.ca === undefined ? undefined : await readFileAt(tls.ca.file, `${path}.tls.ca`, context);
  const cert =
    tls.cert === undefined
      ? undefined
      : await readFileAt(tls.cert.file, `${path}.tls.cert`, context);
  // The private key is as sensitive as a password, so it travels wrapped.
  const key =
    tls.key === undefined
      ? undefined
      : new Secret(
          await readFileAt(tls.key.file, `${path}.tls.key`, context),
          `file:${tls.key.file}`,
        );
  const keyPassphrase =
    tls.keyPassphrase === undefined
      ? undefined
      : await resolveSecret(tls.keyPassphrase, `${path}.tls.keyPassphrase`, context);

  return {
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    ...(keyPassphrase === undefined ? {} : { keyPassphrase }),
    ...(tls.serverName === undefined ? {} : { serverName: tls.serverName }),
    alpn: tls.alpn,
    rejectUnauthorized: tls.rejectUnauthorized,
  };
}

function toClientId(clientId: BrokerDocument['clientId']): ClientIdConfig {
  return 'fixed' in clientId
    ? { kind: 'fixed', value: clientId.fixed }
    : { kind: 'prefix', prefix: clientId.prefix };
}

/**
 * Merges the global and per-broker read rules (ADR-0004).
 *
 * Deny lists are unioned: a broker can forbid more, never less. An allow list on the broker
 * replaces the global one, so a broker can be narrowed without rewriting the global policy.
 */
function mergeReadPolicy(document: ConfigDocument, broker: BrokerDocument): ReadPolicyConfig {
  const deny = [...new Set([...document.security.read.deny, ...broker.security.read.deny])];
  return {
    allow: broker.security.read.allow ?? document.security.read.allow,
    deny,
  };
}

async function resolveBroker(
  id: BrokerId,
  broker: BrokerDocument,
  document: ConfigDocument,
  context: ResolutionContext,
): Promise<BrokerConfig> {
  const path = `brokers.${id}`;
  const auth = await resolveAuth(broker, path, context);
  const tls = await resolveTls(broker, path, context);

  return {
    id,
    url: broker.url,
    protocolVersion: broker.protocolVersion,
    clientId: toClientId(broker.clientId),
    connect: broker.connect,
    ...(auth === undefined ? {} : { auth }),
    ...(tls === undefined ? {} : { tls }),
    timeouts: broker.timeouts,
    reconnect: broker.reconnect,
    discovery: broker.discovery,
    readPolicy: mergeReadPolicy(document, broker),
  };
}

/** Freezes plain objects and arrays, leaving secrets, binary material and maps intact. */
function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Secret || ArrayBuffer.isView(value)) {
    return value;
  }
  if (value instanceof Map) {
    for (const entry of value.values()) {
      deepFreeze(entry);
    }
    return Object.freeze(value);
  }
  for (const entry of Object.values(value)) {
    deepFreeze(entry);
  }
  return Object.freeze(value);
}

export async function resolveConfig(
  document: ConfigDocument,
  options: ResolveConfigOptions = {},
): Promise<EngineConfig> {
  const context: ResolutionContext = {
    env: options.env ?? process.env,
    baseDir: options.baseDir ?? process.cwd(),
  };

  const brokers = new Map<BrokerId, BrokerConfig>();
  for (const [id, broker] of Object.entries(document.brokers)) {
    const brokerId = id as BrokerId;
    brokers.set(brokerId, await resolveBroker(brokerId, broker, document, context));
  }

  return deepFreeze({
    brokers,
    security: {
      redaction: {
        jsonKeys: document.security.redaction.jsonKeys.map((key) => key.toLowerCase()),
      },
      publishEnabled: false,
    },
    limits: document.limits,
    mcp: document.mcp,
    storage: document.storage,
    logging: document.logging,
  });
}

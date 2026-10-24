/**
 * The configuration document, as written by an operator (ADR-0013).
 *
 * Three rules shape this schema:
 *
 * - **Unknown keys are errors.** A typo in `deny` must never be silently ignored: a security
 *   rule that does not apply is worse than a configuration that refuses to start.
 * - **Secrets are references, never values.** `{ env }` or `{ file }`; a plain string is
 *   rejected with an explanation.
 * - **Every limit has a default and a bound**, so a configuration cannot ask for unbounded
 *   memory, and an omitted section still produces a safe engine.
 *
 * This describes the *document*. Resolving references and files produces the `EngineConfig`
 * the engine actually runs on (see `resolve.ts`).
 */
import * as z from 'zod';
import { isBrokerId } from '../domain/ids.js';
import { isTopicFilter, parseTopicFilter } from '../domain/topic.js';

export const CONFIG_VERSION = 1;

/** JSON keys redacted in payload views unless the operator overrides the list. */
export const DEFAULT_REDACTED_KEYS: readonly string[] = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'credential',
  'credentials',
  'privatekey',
  'private_key',
  'passphrase',
];

const MEGABYTE = 1024 * 1024;

const environmentRefSchema = z.strictObject({ env: z.string().min(1) });
const fileRefSchema = z.strictObject({ file: z.string().min(1) });

const secretRefSchema = z.union([environmentRefSchema, fileRefSchema], {
  error: (issue) =>
    typeof issue.input === 'string'
      ? 'Plain-text secrets are not allowed. Use { env: "VARIABLE" } or { file: "/path" }.'
      : 'Expected a secret reference: { env: "VARIABLE" } or { file: "/path" }.',
});

/** Certificates are not secret, but they still live in files beside the configuration. */
const materialRefSchema = fileRefSchema;

const topicFilterSchema = z
  .string()
  .refine(isTopicFilter, 'Not a valid MQTT topic filter: check "+" and "#" placement.');

const brokerIdSchema = z
  .string()
  .refine(
    isBrokerId,
    'Broker id must be 1 to 63 characters: lowercase letters, digits, "-" or "_", starting with a letter or digit.',
  );

const BROKER_URL_SCHEMES = new Set(['mqtt:', 'mqtts:', 'ws:', 'wss:']);

const brokerUrlSchema = z.string().superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'Not a valid URL, for example "mqtts://broker.example.com:8883".',
    });
    return;
  }
  if (!BROKER_URL_SCHEMES.has(url.protocol)) {
    context.addIssue({
      code: 'custom',
      message: `Unsupported scheme "${url.protocol}". Use mqtt, mqtts, ws or wss.`,
    });
  }
  if (url.username !== '' || url.password !== '') {
    context.addIssue({
      code: 'custom',
      message:
        'Credentials must not appear in the URL. Use auth.username and auth.password with { env } or { file }.',
    });
  }
});

const qosSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

const authSchema = z.strictObject({
  // A username is not a secret, so it may be written inline.
  username: z.union([z.string().min(1), secretRefSchema]).optional(),
  password: secretRefSchema.optional(),
});

const tlsSchema = z
  .strictObject({
    ca: materialRefSchema.optional(),
    cert: materialRefSchema.optional(),
    key: materialRefSchema.optional(),
    keyPassphrase: secretRefSchema.optional(),
    serverName: z.string().min(1).optional(),
    /** For example ["x-amzn-mqtt-ca"] on AWS IoT Core over port 443. */
    alpn: z.array(z.string().min(1)).default([]),
    rejectUnauthorized: z.boolean().default(true),
  })
  .refine(
    (tls) => (tls.cert === undefined) === (tls.key === undefined),
    'Mutual TLS needs both "cert" and "key".',
  );

const clientIdSchema = z.union([
  z.strictObject({ prefix: z.string().min(1).max(32) }),
  // A fixed client id collides with any device already using it, and the broker then
  // disconnects that device, so it is opt-in and never the default.
  z.strictObject({ fixed: z.string().min(1).max(128) }),
]);

const discoverySchema = z.strictObject({
  enabled: z.boolean().default(true),
  filters: z
    .array(topicFilterSchema)
    .min(1)
    .default([parseTopicFilter('#')]),
  /** "#" never matches $-prefixed topics, so $SYS must be requested explicitly. */
  includeSysTopics: z.boolean().default(false),
  subscriptionQos: qosSchema.default(0),
});

const readPolicySchema = z.strictObject({
  allow: z.array(topicFilterSchema).default([parseTopicFilter('#')]),
  deny: z.array(topicFilterSchema).default([]),
});

const brokerSecuritySchema = z.strictObject({
  read: z
    .strictObject({
      allow: z.array(topicFilterSchema).optional(),
      deny: z.array(topicFilterSchema).default([]),
    })
    .prefault({}),
});

const brokerSchema = z.strictObject({
  url: brokerUrlSchema,
  /** 5 is MQTT 5, 4 is MQTT 3.1.1. */
  protocolVersion: z.union([z.literal(5), z.literal(4)]).default(5),
  clientId: clientIdSchema.prefault({ prefix: 'mqtt-observer' }),
  connect: z.enum(['startup', 'lazy']).default('startup'),
  auth: authSchema.optional(),
  tls: tlsSchema.optional(),
  timeouts: z
    .strictObject({
      connectMs: z.int().min(1000).max(120_000).default(10_000),
      keepaliveSeconds: z.int().min(5).max(3600).default(30),
    })
    .prefault({}),
  reconnect: z
    .strictObject({
      initialDelayMs: z.int().min(100).max(60_000).default(1000),
      maxDelayMs: z.int().min(1000).max(3_600_000).default(60_000),
    })
    .prefault({})
    .refine(
      (reconnect) => reconnect.initialDelayMs <= reconnect.maxDelayMs,
      'reconnect.initialDelayMs must not exceed reconnect.maxDelayMs.',
    ),
  discovery: discoverySchema.prefault({}),
  security: brokerSecuritySchema.prefault({}),
});

const securitySchema = z.strictObject({
  read: readPolicySchema.prefault({}),
  redaction: z
    .strictObject({
      jsonKeys: z.array(z.string().min(1)).default([...DEFAULT_REDACTED_KEYS]),
    })
    .prefault({}),
  publish: z
    .strictObject({
      enabled: z
        .boolean()
        .default(false)
        .refine(
          (enabled) => !enabled,
          'Publishing is not implemented in this version. It arrives in V0.4, behind an allow-list with deny precedence.',
        ),
    })
    .prefault({}),
});

const limitsSchema = z
  .strictObject({
    maxTopicsPerBroker: z.int().min(1).max(5_000_000).default(50_000),
    onTopicLimit: z.enum(['evict-lru', 'ignore-new']).default('evict-lru'),
    /** Payloads larger than this are never parsed; they stay classified as unknown. */
    maxInspectBytes: z
      .int()
      .min(1)
      .max(16 * MEGABYTE)
      .default(256 * 1024),
    maxStoredPayloadBytes: z.int().min(1).max(MEGABYTE).default(8192),
    recentMessagesPerTopic: z.int().min(1).max(1000).default(20),
    messageStoreMaxBytes: z
      .int()
      .min(MEGABYTE)
      .max(4096 * MEGABYTE)
      .default(128 * MEGABYTE),
    pendingPayloadMaxBytes: z
      .int()
      .min(MEGABYTE)
      .max(4096 * MEGABYTE)
      .default(64 * MEGABYTE),
    flushIntervalMs: z.int().min(10).max(5000).default(100),
    inspectionsPerFlush: z.int().min(1).max(100_000).default(2000),
  })
  .prefault({})
  .refine(
    (limits) => limits.maxStoredPayloadBytes <= limits.maxInspectBytes,
    'limits.maxStoredPayloadBytes must not exceed limits.maxInspectBytes: a payload cannot be stored in more detail than it is inspected.',
  );

const mcpSchema = z
  .strictObject({
    maxResultItems: z.int().min(1).max(1000).default(200),
    maxPayloadPreviewChars: z.int().min(1).max(100_000).default(2000),
    discoverMaxWaitSeconds: z.int().min(1).max(300).default(30),
  })
  .prefault({});

const storageSchema = z
  .strictObject({
    type: z.literal('memory').default('memory'),
  })
  .prefault({});

const loggingSchema = z
  .strictObject({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    /** Logs always go to stderr: stdout carries MCP protocol frames. */
    format: z.enum(['json', 'pretty']).default('json'),
  })
  .prefault({});

export const configDocumentSchema = z.strictObject({
  version: z.literal(CONFIG_VERSION, {
    error: `Unsupported configuration version. This release reads version ${String(CONFIG_VERSION)}.`,
  }),
  brokers: z
    .record(brokerIdSchema, brokerSchema)
    .refine((brokers) => Object.keys(brokers).length > 0, 'At least one broker is required.'),
  security: securitySchema.prefault({}),
  limits: limitsSchema.prefault({}),
  mcp: mcpSchema.prefault({}),
  storage: storageSchema.prefault({}),
  logging: loggingSchema.prefault({}),
});

export type ConfigDocument = z.infer<typeof configDocumentSchema>;
export type BrokerDocument = z.infer<typeof brokerSchema>;
export type SecretRefDocument = z.infer<typeof secretRefSchema>;

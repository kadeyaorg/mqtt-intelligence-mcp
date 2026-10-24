/**
 * The schemas of the tool surface.
 *
 * These are a public API: an agent's prompts and a user's expectations are built on the
 * names and shapes here, so changing one is a breaking change (ADR-0012). They are declared
 * once and shared, rather than inlined per tool, so that "coverage" and "limitations" mean
 * exactly the same thing in every answer.
 */
import { isBrokerId, isTopicFilter, isTopicName } from '@kadeya/mqtt-intelligence-core';
import * as z from 'zod';

export const brokerIdSchema = z
  .string()
  .refine(isBrokerId, 'Not a valid broker id.')
  .describe('Which configured broker to ask. Optional when exactly one is configured.');

export const topicNameSchema = z
  .string()
  .refine(isTopicName, 'Not a valid MQTT topic name.')
  .describe('An exact topic, with no wildcard.');

export const topicFilterSchema = z
  .string()
  .refine(isTopicFilter, 'Not a valid MQTT topic filter.')
  .describe('An MQTT topic filter, where "+" matches one level and "#" matches a subtree.');

export const limitationSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const coverageSchema = z.object({
  brokerId: z.string(),
  filters: z.array(z.string()),
  rejectedFilters: z.array(z.object({ filter: z.string(), reason: z.string() })),
  observingSince: z.number().optional(),
  observedMs: z.number(),
  gaps: z.array(z.object({ from: z.number(), to: z.number().optional(), reason: z.string() })),
  droppedPayloads: z.number(),
  deniedMessages: z.number(),
  evictedTopics: z.number(),
  ignoredTopics: z.number(),
  topicCount: z.number(),
  messageCount: z.number(),
});

/** Every answer carries what it could see and what it cannot tell. */
export function answerSchema<Facts extends z.ZodType>(facts: Facts) {
  return z.object({
    facts,
    coverage: coverageSchema,
    limitations: z.array(limitationSchema),
  });
}

export function answerWithObservationsSchema<
  Facts extends z.ZodType,
  Observations extends z.ZodType,
>(facts: Facts, observations: Observations) {
  return z.object({
    facts,
    observations: observations.optional(),
    coverage: coverageSchema,
    limitations: z.array(limitationSchema),
  });
}

export const payloadViewSchema = z.union([
  z.object({ kind: z.literal('empty') }),
  z.object({
    kind: z.literal('json'),
    value: z.json(),
    truncated: z.boolean(),
    redactedKeys: z.number(),
  }),
  z.object({ kind: z.literal('number'), value: z.number(), raw: z.string().optional() }),
  z.object({ kind: z.literal('boolean'), value: z.boolean() }),
  z.object({ kind: z.literal('text'), text: z.string(), truncated: z.boolean() }),
  z.object({
    kind: z.literal('binary'),
    size: z.number(),
    hexPreview: z.string(),
    sha256: z.string().optional(),
    truncated: z.boolean(),
  }),
  z.object({
    kind: z.literal('decoded'),
    decoder: z.string(),
    value: z.json(),
    truncated: z.boolean(),
    redactedKeys: z.number(),
  }),
  z.object({ kind: z.literal('unknown'), size: z.number(), reason: z.string() }),
]);

export const messagePropertiesSchema = z.object({
  contentType: z.string().optional(),
  payloadFormatIndicator: z.number().optional(),
  messageExpiryInterval: z.number().optional(),
  responseTopic: z.string().optional(),
  correlationDataSize: z.number().optional(),
  userProperties: z.array(z.tuple([z.string(), z.string()])).optional(),
});

export const messageFactSchema = z.object({
  receivedAt: z.number().describe('Receipt time in epoch milliseconds. Not a publish time.'),
  sequence: z.number(),
  deliveredQos: z.number().describe('Delivered QoS: min(publisher QoS, subscription QoS).'),
  retainedReplay: z.boolean().describe('True when the broker replayed a retained message.'),
  payloadSize: z.number(),
  payload: payloadViewSchema,
  properties: messagePropertiesSchema.optional(),
});

export const topicSummarySchema = z.object({
  brokerId: z.string(),
  topic: z.string(),
  messageCount: z.number(),
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
  lastLiveAt: z.number().optional(),
  payloadKinds: z.record(z.string(), z.number()),
  retainedState: z.string(),
  messagesPerSecond: z.number(),
});

export const topicTreeNodeSchema: z.ZodType = z.lazy(() =>
  z.object({
    segment: z.string(),
    path: z.string(),
    topicCount: z.number(),
    messageCount: z.number(),
    lastSeenAt: z.number().optional(),
    isTopic: z.boolean(),
    children: z.array(topicTreeNodeSchema),
    truncatedChildren: z.number(),
    foldedBranches: z.number().optional(),
  }),
);

export const schemaFieldSchema = z.object({
  path: z.string().describe('Dotted path; "[]" is an array element and "{}" a map value.'),
  types: z.array(z.string()),
  presence: z.number().describe('Share of the parent values that carried it, 0 to 1.'),
  truncated: z.boolean(),
});

export const schemaChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(['appeared', 'disappeared']),
  at: z.number().describe('Receipt time, in epoch milliseconds.'),
  types: z.array(z.string()),
});

export const relatedTopicSchema = z.object({
  topic: z.string(),
  reason: z.enum(['sibling', 'same-leaf', 'same-shape']),
  explanation: z.string(),
  messageCount: z.number(),
});

/**
 * The MCP surface: six tools over the engine (ADR-0012).
 *
 * Six, not sixteen. Every tool definition costs context in the agent's window and dilutes
 * tool selection, so each one must answer a question a person actually asks: what is out
 * there, what does the namespace look like, where is this thing, what is this topic, what
 * did it just say.
 *
 * The adapter is deliberately thin. It validates, clamps, calls the engine, renders, and
 * maps errors. It makes no security decision of its own — those all live in the engine, so
 * they hold whatever drives it (ADR-0003).
 */
import type { Engine, Logger } from '@kadeya/mqtt-intel-core';
import { noopLogger } from '@kadeya/mqtt-intel-core';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { toToolError } from './errors.js';
import {
  formatCount,
  formatDuration,
  formatInstant,
  formatPayload,
  renderAnswer,
  renderRelatedTopics,
  renderSchemaChanges,
  renderSchemaFields,
  UNTRUSTED_PAYLOAD_NOTE,
} from './render/answer.js';
import {
  answerSchema,
  answerWithObservationsSchema,
  brokerIdSchema,
  coverageSchema,
  messageFactSchema,
  relatedTopicSchema,
  schemaChangeSchema,
  schemaFieldSchema,
  topicFilterSchema,
  topicNameSchema,
  topicSummarySchema,
  topicTreeNodeSchema,
} from './schemas.js';

export interface McpServerOptions {
  readonly logger?: Logger;
  readonly name?: string;
  readonly version?: string;
}

/** Nothing here changes the broker: the engine has no publish path in this version. */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;

type Guard = (tool: string, run: () => Promise<CallToolResult>) => Promise<CallToolResult>;

interface TreeLike {
  readonly segment: string;
  readonly path: string;
  readonly topicCount: number;
  readonly messageCount: number;
  readonly isTopic: boolean;
  readonly children: readonly TreeLike[];
  readonly truncatedChildren: number;
  readonly foldedBranches?: number;
}

function renderTree(node: TreeLike, indent: string): string {
  const label = node.segment === '' ? (node.path === '' ? '(root)' : node.path) : node.segment;
  const marker = node.isTopic ? ' [topic]' : '';
  const folded =
    node.foldedBranches === undefined
      ? ''
      : ` [${formatCount(node.foldedBranches)} branches folded into this shape]`;
  const lines = [
    `${indent}${label}${marker}${folded} — ${formatCount(node.topicCount)} topic(s), ${formatCount(node.messageCount)} message(s)`,
  ];
  for (const child of node.children) {
    lines.push(renderTree(child, `${indent}  `));
  }
  if (node.truncatedChildren > 0) {
    lines.push(`${indent}  … ${formatCount(node.truncatedChildren)} more branch(es) not shown`);
  }
  return lines.join('\n');
}

export function createMcpServer(engine: Engine, options: McpServerOptions = {}): McpServer {
  const logger = (options.logger ?? noopLogger).child({ component: 'mcp' });
  const server = new McpServer({
    name: options.name ?? 'mqtt-intelligence-mcp',
    version: options.version ?? '0.1.0',
  });

  /** The audit log and error mapping every tool shares. */
  const guard: Guard = async (tool, run) => {
    const startedAt = Date.now();
    try {
      const result = await run();
      logger.info('Tool call', { tool, durationMs: Date.now() - startedAt, outcome: 'ok' });
      return result;
    } catch (error) {
      logger.info('Tool call', { tool, durationMs: Date.now() - startedAt, outcome: 'error' });
      return toToolError(error, logger, tool);
    }
  };

  registerListBrokers(server, engine, guard);
  registerDiscoverTopics(server, engine, guard);
  registerTopicTree(server, engine, guard);
  registerSearchTopics(server, engine, guard);
  registerDescribeTopic(server, engine, guard);
  registerRecentMessages(server, engine, guard);
  registerInferSchema(server, engine, guard);

  return server;
}

function registerListBrokers(server: McpServer, engine: Engine, guard: Guard): void {
  const brokerReport = z.object({
    brokerId: z.string(),
    url: z.string(),
    protocolVersion: z.number(),
    state: z.string(),
    connectedSince: z.number().optional(),
    reconnections: z.number(),
    lastFailure: z.object({ code: z.string(), message: z.string(), at: z.number() }).optional(),
    tls: z.object({ enabled: z.boolean(), mutual: z.boolean(), verified: z.boolean() }),
    coverage: coverageSchema,
  });

  server.registerTool(
    'mqtt_list_brokers',
    {
      title: 'List MQTT brokers',
      description:
        'Lists the configured MQTT brokers with their connection state and what discovery has been able to observe on each. Start here when several brokers are configured, or when another tool reports a broker problem.',
      inputSchema: z.object({}),
      outputSchema: z.object({ brokers: z.array(brokerReport) }),
      annotations: { ...READ_ONLY, idempotentHint: true },
    },
    async () =>
      guard('mqtt_list_brokers', async () => {
        const reports = await engine.listBrokers();
        const output = {
          brokers: reports.map((report) => ({
            brokerId: report.brokerId,
            url: report.url,
            protocolVersion: report.protocolVersion,
            state: report.status.state,
            ...(report.status.connectedSince === undefined
              ? {}
              : { connectedSince: report.status.connectedSince }),
            reconnections: report.status.reconnections,
            ...(report.status.lastFailure === undefined
              ? {}
              : { lastFailure: report.status.lastFailure }),
            tls: report.tls,
            coverage: report.discovery,
          })),
        };

        const lines = output.brokers.map((broker) => {
          const tls = broker.tls.enabled
            ? `TLS${broker.tls.mutual ? '+mTLS' : ''}${broker.tls.verified ? '' : ' (unverified!)'}`
            : 'no TLS';
          const failure =
            broker.lastFailure === undefined ? '' : ` · last failure ${broker.lastFailure.code}`;
          return `- ${broker.brokerId}: ${broker.state} · ${broker.url} · MQTT ${String(broker.protocolVersion)} · ${tls} · ${formatCount(broker.coverage.topicCount)} topic(s) observed over ${formatDuration(broker.coverage.observedMs)}${failure}`;
        });

        return {
          content: [
            {
              type: 'text' as const,
              text:
                lines.length === 0 ? 'No broker is configured.' : `BROKERS\n${lines.join('\n')}`,
            },
          ],
          structuredContent: output,
        };
      }),
  );
}

function registerDiscoverTopics(server: McpServer, engine: Engine, guard: Guard): void {
  server.registerTool(
    'mqtt_discover_topics',
    {
      title: 'Discover MQTT topics',
      description:
        'Connects the broker if needed, makes sure discovery is observing, and reports what is known so far: how many topics, the top-level branches, and how long observation has lasted. Pass waitSeconds to keep watching before answering, which is how rarely-publishing topics are found. Nothing observed never means nothing exists.',
      inputSchema: z.object({
        broker: brokerIdSchema.optional(),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(300)
          .optional()
          .describe('Seconds to keep observing before answering. Clamped by server configuration.'),
      }),
      outputSchema: answerSchema(
        z.object({
          brokerId: z.string(),
          topicCount: z.number(),
          topicsDiscoveredWhileWaiting: z.number(),
          messageCount: z.number(),
          waitedMs: z.number(),
          topLevels: z.array(z.object({ segment: z.string(), topicCount: z.number() })),
        }),
      ),
      annotations: { ...READ_ONLY, idempotentHint: false },
    },
    async (args, context) =>
      guard('mqtt_discover_topics', async () => {
        const progressToken = context.mcpReq._meta?.progressToken;
        const answer = await engine.discover(
          {
            ...(args.broker === undefined ? {} : { brokerId: args.broker }),
            ...(args.waitSeconds === undefined ? {} : { waitSeconds: args.waitSeconds }),
          },
          {
            signal: context.mcpReq.signal,
            ...(progressToken === undefined
              ? {}
              : {
                  // Progress keeps a waiting client from timing the call out.
                  onProgress: (update) => {
                    void context.mcpReq.notify({
                      method: 'notifications/progress',
                      params: {
                        progressToken,
                        progress: update.ratio ?? 0,
                        total: 1,
                        message: update.message,
                      },
                    });
                  },
                }),
          },
        );

        const branches = answer.facts.topLevels
          .map((level) => `  ${level.segment}/ — ${formatCount(level.topicCount)} topic(s)`)
          .join('\n');

        const body = [
          `DISCOVERY on broker "${answer.facts.brokerId}"`,
          `  ${formatCount(answer.facts.topicCount)} topic(s), ${formatCount(answer.facts.messageCount)} message(s) observed`,
          answer.facts.waitedMs > 0
            ? `  waited ${formatDuration(answer.facts.waitedMs)}, discovering ${formatCount(answer.facts.topicsDiscoveredWhileWaiting)} new topic(s)`
            : '',
          branches === '' ? '' : `TOP LEVELS\n${branches}`,
        ]
          .filter((line) => line !== '')
          .join('\n');

        return {
          content: [{ type: 'text' as const, text: renderAnswer(body, answer) }],
          structuredContent: answer,
        };
      }),
  );
}

function registerTopicTree(server: McpServer, engine: Engine, guard: Guard): void {
  server.registerTool(
    'mqtt_topic_tree',
    {
      title: 'MQTT topic tree',
      description:
        'Shows the observed namespace as a tree, with per-branch topic and message counts. This is the tool for "explain the architecture of this system": a collapsed tree says more than a flat list of thousands of topics.',
      inputSchema: z.object({
        broker: brokerIdSchema.optional(),
        root: z
          .array(z.string())
          .optional()
          .describe('Levels to start from, for example ["factory", "line-01"].'),
        depth: z.number().int().min(1).max(8).optional().describe('Levels to expand. Default 3.'),
        maxChildren: z.number().int().min(1).max(200).optional(),
        foldPatterns: z
          .boolean()
          .optional()
          .describe(
            'Fold sibling branches whose names differ only in a number or an identifier, so a namespace keyed by device id stays readable. Default true; turn it off to see every branch as published.',
          ),
      }),
      outputSchema: answerSchema(topicTreeNodeSchema),
      annotations: { ...READ_ONLY, idempotentHint: true },
    },
    async (args) =>
      guard('mqtt_topic_tree', async () => {
        const answer = await engine.topicTree({
          ...(args.broker === undefined ? {} : { brokerId: args.broker }),
          ...(args.root === undefined ? {} : { root: args.root }),
          ...(args.depth === undefined ? {} : { depth: args.depth }),
          ...(args.maxChildren === undefined ? {} : { maxChildren: args.maxChildren }),
          ...(args.foldPatterns === undefined ? {} : { foldPatterns: args.foldPatterns }),
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: renderAnswer(`TOPIC TREE\n${renderTree(answer.facts, '')}`, answer),
            },
          ],
          structuredContent: answer,
        };
      }),
  );
}

function registerSearchTopics(server: McpServer, engine: Engine, guard: Guard): void {
  server.registerTool(
    'mqtt_search_topics',
    {
      title: 'Search MQTT topics',
      description:
        'Finds observed topics by MQTT filter, by substring, or by activity, sorted by name, last activity, message count or rate. Use it for "find everything about the robot", "what is busiest", or "what stopped publishing". Results are paginated: pass the returned cursor to continue.',
      inputSchema: z.object({
        broker: brokerIdSchema.optional(),
        filter: topicFilterSchema.optional(),
        text: z.string().min(1).optional().describe('Case-insensitive substring of the topic.'),
        activeSinceMs: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Only topics with a live message in the last N milliseconds.'),
        silentForMs: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Only topics with no live message in the last N milliseconds.'),
        firstSeenSinceMs: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Only topics this server first saw in the last N milliseconds, which is how "what is new?" is asked. First seen means first seen here, not first published: a topic that has existed for years looks new the first time we are watching when it publishes.',
          ),
        sortBy: z.enum(['topic', 'lastSeenAt', 'messageCount', 'rate']).optional(),
        descending: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
      }),
      outputSchema: answerSchema(
        z.object({
          topics: z.array(topicSummarySchema),
          nextCursor: z.string().optional(),
        }),
      ),
      annotations: { ...READ_ONLY, idempotentHint: true },
    },
    async (args) =>
      guard('mqtt_search_topics', async () => {
        // No clock here on purpose: the engine owns time, so durations go through as they
        // arrived and an engine on a different clock still answers about its own present.
        const answer = await engine.searchTopics({
          ...(args.broker === undefined ? {} : { brokerId: args.broker }),
          ...(args.filter === undefined ? {} : { filter: args.filter }),
          ...(args.text === undefined ? {} : { text: args.text }),
          ...(args.activeSinceMs === undefined ? {} : { activeWithinMs: args.activeSinceMs }),
          ...(args.silentForMs === undefined ? {} : { silentForMs: args.silentForMs }),
          ...(args.firstSeenSinceMs === undefined
            ? {}
            : { firstSeenWithinMs: args.firstSeenSinceMs }),
          ...(args.sortBy === undefined ? {} : { sortBy: args.sortBy }),
          ...(args.descending === undefined ? {} : { descending: args.descending }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        });

        const lines = answer.facts.topics.map(
          (topic) =>
            `- ${topic.topic} — ${formatCount(topic.messageCount)} msg, ${topic.messagesPerSecond.toFixed(2)}/s, last ${formatInstant(topic.lastSeenAt)}`,
        );
        const more =
          answer.facts.nextCursor === undefined
            ? ''
            : `\n(more available; cursor "${answer.facts.nextCursor}")`;

        return {
          content: [
            {
              type: 'text' as const,
              text: renderAnswer(
                lines.length === 0
                  ? 'No observed topic matches.'
                  : `TOPICS (${formatCount(lines.length)})\n${lines.join('\n')}${more}`,
                answer,
              ),
            },
          ],
          structuredContent: answer,
        };
      }),
  );
}

function registerDescribeTopic(server: McpServer, engine: Engine, guard: Guard): void {
  server.registerTool(
    'mqtt_describe_topic',
    {
      title: 'Describe an MQTT topic',
      description: `Everything observed about one topic: how many messages, when they arrived, delivered QoS, retained state, payload kinds, the last payload, plus computed observations such as the message rate and the intervals between messages. ${UNTRUSTED_PAYLOAD_NOTE}`,
      inputSchema: z.object({
        broker: brokerIdSchema.optional(),
        topic: topicNameSchema,
      }),
      outputSchema: answerWithObservationsSchema(
        z.object({
          brokerId: z.string(),
          topic: z.string(),
          firstSeenAt: z.number(),
          lastSeenAt: z.number(),
          lastLiveAt: z.number().optional(),
          messageCount: z.number(),
          retainedReplayCount: z.number(),
          bytesTotal: z.number(),
          maxPayloadSize: z.number(),
          deliveredQosCounts: z.object({ qos0: z.number(), qos1: z.number(), qos2: z.number() }),
          retainedState: z.string(),
          payloadKinds: z.record(z.string(), z.number()),
          inspectedCount: z.number(),
          lastMessage: messageFactSchema.optional(),
        }),
        z.object({
          messagesPerSecond: z.number(),
          rateMethod: z.string(),
          interArrival: z
            .object({
              count: z.number(),
              meanMs: z.number(),
              minMs: z.number(),
              maxMs: z.number(),
              standardDeviationMs: z.number().optional(),
            })
            .optional(),
          intervalGroups: z
            .array(z.object({ fromMs: z.number(), toMs: z.number(), count: z.number() }))
            .optional()
            .describe(
              'Groups of inter-arrival times, present only when there is more than one. Separate groups mean the gaps fall into separate populations, which a topic published once per cycle does not have. What produces them is not something arrival times can settle.',
            ),
          schema: z
            .object({
              payloadsInspected: z.number(),
              fields: z.array(schemaFieldSchema),
              changes: z.array(schemaChangeSchema),
              truncated: z.boolean(),
            })
            .optional()
            .describe(
              'Shape of the JSON payloads inspected so far. A summary of what was seen, not a contract: a field below full presence was absent from some payloads, which is not the same as being optional by design. Use mqtt_infer_schema for the exportable JSON Schema.',
            ),
          related: z
            .array(relatedTopicSchema)
            .optional()
            .describe(
              'Other topics related to this one by name. Relations are facts about the names and nothing else: two topics ending in the same level are related by convention, not by wiring, and each carries the reason so the claim can be judged rather than assumed.',
            ),
          silence: z.object({ forMs: z.number(), ratioToMeanInterval: z.number() }).optional(),
        }),
      ),
      annotations: { ...READ_ONLY, idempotentHint: true },
    },
    async (args) =>
      guard('mqtt_describe_topic', async () => {
        const answer = await engine.describeTopic({
          ...(args.broker === undefined ? {} : { brokerId: args.broker }),
          topic: args.topic,
        });
        const facts = answer.facts;
        const observations = answer.observations;

        const kinds = Object.entries(facts.payloadKinds)
          .map(([kind, count]) => `${kind} ${formatCount(count)}`)
          .join(', ');

        const body = [
          `TOPIC ${facts.topic} (broker "${facts.brokerId}")`,
          'FACTS',
          `  ${formatCount(facts.messageCount)} message(s), ${formatCount(facts.retainedReplayCount)} retained replay(s), ${formatCount(facts.bytesTotal)} bytes`,
          `  first seen ${formatInstant(facts.firstSeenAt)} · last seen ${formatInstant(facts.lastSeenAt)} · last live ${formatInstant(facts.lastLiveAt)}`,
          `  delivered QoS: 0×${formatCount(facts.deliveredQosCounts.qos0)} 1×${formatCount(facts.deliveredQosCounts.qos1)} 2×${formatCount(facts.deliveredQosCounts.qos2)} · retained: ${facts.retainedState}`,
          `  payload kinds (over ${formatCount(facts.inspectedCount)} inspected): ${kinds === '' ? 'none inspected' : kinds}`,
          facts.lastMessage === undefined
            ? '  no payload kept'
            : `  last payload: ${formatPayload(facts.lastMessage.payload)}`,
          'OBSERVATIONS',
          `  rate: ${(observations?.messagesPerSecond ?? 0).toFixed(3)} msg/s (${observations?.rateMethod ?? 'n/a'})`,
          observations?.interArrival === undefined
            ? ''
            : `  intervals: mean ${formatDuration(observations.interArrival.meanMs)}, min ${formatDuration(observations.interArrival.minMs)}, max ${formatDuration(observations.interArrival.maxMs)} (n=${formatCount(observations.interArrival.count)})`,
          observations?.intervalGroups === undefined
            ? ''
            : `  intervals fall into ${formatCount(observations.intervalGroups.length)} groups: ${observations.intervalGroups
                .map(
                  (group) =>
                    `${formatDuration(group.fromMs)}–${formatDuration(group.toMs)} (${formatCount(group.count)})`,
                )
                .join(
                  ', ',
                )}. A topic published once per cycle has one group; what produces the others is not something arrival times can settle.`,
          observations?.schema === undefined
            ? ''
            : [
                `  shape, from ${formatCount(observations.schema.payloadsInspected)} inspected payload(s):`,
                ...renderSchemaFields(observations.schema.fields),
                ...renderSchemaChanges(observations.schema.changes),
              ].join('\n'),
          observations?.related === undefined
            ? ''
            : renderRelatedTopics(observations.related).join('\n'),
          observations?.silence === undefined
            ? ''
            : `  silent for ${formatDuration(observations.silence.forMs)}, which is ${observations.silence.ratioToMeanInterval.toFixed(1)}× its usual interval`,
        ]
          .filter((line) => line !== '')
          .join('\n');

        return {
          content: [{ type: 'text' as const, text: renderAnswer(body, answer) }],
          structuredContent: answer,
        };
      }),
  );
}

function registerRecentMessages(server: McpServer, engine: Engine, guard: Guard): void {
  server.registerTool(
    'mqtt_get_recent_messages',
    {
      title: 'Recent messages of an MQTT topic',
      description: `The most recent messages kept for one topic, newest first, with payloads rendered safely. The last message is exact; older ones are a sample, because ingestion keeps a bounded window. ${UNTRUSTED_PAYLOAD_NOTE}`,
      inputSchema: z.object({
        broker: brokerIdSchema.optional(),
        topic: topicNameSchema,
        limit: z.number().int().min(1).max(50).optional().describe('Default 5.'),
      }),
      outputSchema: answerSchema(
        z.object({
          brokerId: z.string(),
          topic: z.string(),
          messages: z.array(messageFactSchema),
        }),
      ),
      annotations: { ...READ_ONLY, idempotentHint: true },
    },
    async (args) =>
      guard('mqtt_get_recent_messages', async () => {
        const answer = await engine.recentMessages({
          ...(args.broker === undefined ? {} : { brokerId: args.broker }),
          topic: args.topic,
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        });

        const lines = answer.facts.messages.map(
          (message) =>
            `- ${formatInstant(message.receivedAt)} · qos ${String(message.deliveredQos)}${message.retainedReplay ? ' · retained replay' : ''} · ${formatPayload(message.payload)}`,
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: renderAnswer(
                lines.length === 0
                  ? `No message kept for ${answer.facts.topic}.`
                  : `MESSAGES on ${answer.facts.topic} (newest first)\n${lines.join('\n')}`,
                answer,
              ),
            },
          ],
          structuredContent: answer,
        };
      }),
  );
}

function registerInferSchema(server: McpServer, engine: Engine, guard: Guard): void {
  server.registerTool(
    'mqtt_infer_schema',
    {
      title: 'Infer the schema of an MQTT topic',
      description: `The shape of a topic's JSON payloads, inferred from the payloads observed so far, as a JSON Schema ready to export and as a flat field list with how often each field was present. Use it to write code against a topic, or to compare a topic's shape with what it used to be. A shape inferred from observation summarises what was seen; it is not a contract, and a field present in only some payloads is reported as such rather than guessed at. ${UNTRUSTED_PAYLOAD_NOTE}`,
      inputSchema: z.object({
        broker: brokerIdSchema.optional(),
        topic: topicNameSchema,
      }),
      outputSchema: answerSchema(
        z.object({
          brokerId: z.string(),
          topic: z.string(),
          payloadsInspected: z
            .number()
            .describe(
              'Payloads folded into the shape. Ingestion samples, so not the message count.',
            ),
          messageCount: z.number(),
          jsonSchema: z.json().describe('JSON Schema draft 2020-12.'),
          fields: z.array(schemaFieldSchema),
          changes: z.array(schemaChangeSchema),
          truncated: z.boolean(),
        }),
      ),
      annotations: { ...READ_ONLY, idempotentHint: true },
    },
    async (args) =>
      guard('mqtt_infer_schema', async () => {
        const answer = await engine.inferSchema({
          ...(args.broker === undefined ? {} : { brokerId: args.broker }),
          topic: args.topic,
        });
        const facts = answer.facts;

        const body =
          facts.payloadsInspected === 0
            ? `No JSON payload has been inspected on ${facts.topic}, so there is no shape to report. Ingestion inspects a sample; the topic may still publish JSON.`
            : [
                `SCHEMA of ${facts.topic} (broker "${facts.brokerId}")`,
                `  inferred from ${formatCount(facts.payloadsInspected)} inspected payload(s) of ${formatCount(facts.messageCount)} message(s)`,
                'FIELDS',
                ...renderSchemaFields(facts.fields),
                ...renderSchemaChanges(facts.changes),
                'JSON SCHEMA',
                JSON.stringify(facts.jsonSchema, null, 2)
                  .split('\n')
                  .map((line) => `  ${line}`)
                  .join('\n'),
              ].join('\n');

        return {
          content: [{ type: 'text' as const, text: renderAnswer(body, answer) }],
          structuredContent: answer,
        };
      }),
  );
}

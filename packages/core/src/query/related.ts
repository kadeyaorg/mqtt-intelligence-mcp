/**
 * Which other topics look like this one, and why.
 *
 * An engineer who has found one topic almost always wants its neighbours: the rest of the
 * machine it belongs to, the same reading taken elsewhere, the other stations of its kind.
 * Finding them by hand means guessing at a naming convention nobody wrote down.
 *
 * Every relation here is a **fact about the names**, and each carries the reason in words.
 * That matters more than it sounds: "related" with no reason is an invitation to assume the
 * topics are connected, and two topics ending in `state` are related by convention, not by
 * wiring. A reader given the reason can judge it; a reader given a list cannot.
 *
 * Temporal relations — "these two always publish together" — are deliberately absent. They
 * would be the most useful and the most dangerous: honest co-occurrence needs per-pair state
 * that grows with the square of the namespace (ADR-0009), and of everything this server could
 * report, it is the one most certain to be read as cause (ADR-0011).
 */
import type { TopicCatalog, TopicRecord } from '../catalog/index.js';
import type { BrokerId } from '../domain/ids.js';
import type { TopicName } from '../domain/topic.js';
import { parseTopicFilter, topicLevels } from '../domain/topic.js';

export type RelationReason = 'sibling' | 'same-leaf' | 'same-shape';

export interface RelatedTopic {
  readonly topic: TopicName;
  readonly reason: RelationReason;
  /** Why these two are related, in words, so the reader can judge the claim. */
  readonly explanation: string;
  readonly messageCount: number;
}

/** How many candidates to pull before filtering. Bounded by the catalogue's own page cap. */
const CANDIDATE_LIMIT = 200;

/** Digit runs are the variable part of a name far more often than anything else. */
const DIGIT_RUN = /\d+/g;

function shapeOf(topic: string): string {
  return topic.replace(DIGIT_RUN, '#');
}

export interface RelatedOptions {
  readonly limit?: number;
}

/**
 * Topics related to this one by name, newest relation kinds first.
 *
 * The most specific reason wins when several apply: a numbered twin is more telling than a
 * sibling, and a sibling more than a topic that merely ends the same way.
 */
export async function relatedTopics(
  catalog: TopicCatalog,
  brokerId: BrokerId,
  topic: TopicName,
  options: RelatedOptions = {},
): Promise<readonly RelatedTopic[]> {
  const limit = options.limit ?? 12;
  const levels = topicLevels(topic);
  const leaf = levels.at(-1);
  if (leaf === undefined) {
    return [];
  }
  const parent = levels.slice(0, -1);
  const shape = shapeOf(topic);

  const found = new Map<string, RelatedTopic>();
  const add = (record: TopicRecord, reason: RelationReason, explanation: string): void => {
    if (record.topic === topic || found.has(record.topic)) {
      return;
    }
    found.set(record.topic, {
      topic: record.topic,
      reason,
      explanation,
      messageCount: record.messageCount,
    });
  };

  // Other members of a numbered family, when this topic is one.
  if (shape !== topic) {
    const stem = topic.slice(0, Math.max(0, topic.search(DIGIT_RUN)));
    const byShape = await catalog.query({ brokerId, text: stem, limit: CANDIDATE_LIMIT });
    for (const record of byShape.items) {
      if (shapeOf(record.topic) === shape) {
        add(record, 'same-shape', `Same name but for a number, ${shape}.`);
      }
    }
  }

  // Siblings: everything published one level under the same branch.
  if (parent.length > 0) {
    const branch = parent.join('/');
    const page = await catalog.query({
      brokerId,
      filter: parseTopicFilter(`${branch}/+`),
      limit: CANDIDATE_LIMIT,
    });
    for (const record of page.items) {
      add(record, 'sibling', `Published under the same branch, ${branch}.`);
    }
  }

  // The same reading taken elsewhere. Substring is the only index the catalogue has, so the
  // match is narrowed here rather than trusted as it comes.
  const byLeaf = await catalog.query({ brokerId, text: leaf, limit: CANDIDATE_LIMIT });
  for (const record of byLeaf.items) {
    if (topicLevels(record.topic).at(-1) === leaf) {
      add(record, 'same-leaf', `Ends with the same level, ${leaf}.`);
    }
  }

  // Most specific first: 'the same thing, numbered' tells a reader more than 'same branch',
  // which tells them more than 'same last level'.
  const order: Record<RelationReason, number> = { 'same-shape': 0, sibling: 1, 'same-leaf': 2 };
  return [...found.values()]
    .sort(
      (left, right) =>
        order[left.reason] - order[right.reason] ||
        right.messageCount - left.messageCount ||
        left.topic.localeCompare(right.topic),
    )
    .slice(0, limit);
}

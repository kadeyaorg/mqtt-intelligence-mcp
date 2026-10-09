/**
 * Topic names, topic filters, and the set relations between them.
 *
 * Every rule here comes from the MQTT specification, not from convention, because the
 * subscription manager and the security policy both depend on being exactly right:
 *
 * - a filter's `+` and `#` must each occupy a whole level, and `#` must be last
 *   (MQTT-4.7.1-2, MQTT-4.7.1-3);
 * - `a/#` matches `a` itself: `#` also matches the parent level (MQTT-4.7.1-2);
 * - a filter starting with a wildcard never matches a topic beginning with `$`
 *   (MQTT-4.7.2-1), so `$SYS` trees must be requested explicitly;
 * - names and filters are case sensitive, empty levels are legal (`a//b`, `/a`), and
 *   `a` and `a/` are different topics;
 * - the encoded form is a UTF-8 string: no U+0000, no unpaired surrogate, at most
 *   65,535 bytes (MQTT-1.5.4).
 */
import { ValidationError } from './errors.js';
import type { Brand } from './ids.js';

/** A concrete topic a message was published to. Never contains a wildcard. */
export type TopicName = Brand<string, 'TopicName'>;

/** A subscription pattern, possibly containing `+` or `#`. */
export type TopicFilter = Brand<string, 'TopicFilter'>;

export const TOPIC_SEPARATOR = '/';
export const SINGLE_LEVEL_WILDCARD = '+';
export const MULTI_LEVEL_WILDCARD = '#';
export const SYSTEM_TOPIC_PREFIX = '$';

/** Maximum length of the UTF-8 encoded form, from the MQTT string encoding. */
export const MAX_TOPIC_BYTES = 65_535;

/** Why a string is not a valid topic name or filter. `undefined` means valid. */
function findEncodingIssue(value: string): string | undefined {
  if (value.length === 0) {
    return 'must not be empty';
  }
  if (value.includes('\u0000')) {
    return 'must not contain the null character U+0000';
  }
  if (!value.isWellFormed()) {
    return 'must be well-formed UTF-16, without unpaired surrogates';
  }
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (byteLength > MAX_TOPIC_BYTES) {
    return `must not exceed ${String(MAX_TOPIC_BYTES)} bytes when UTF-8 encoded, got ${String(byteLength)}`;
  }
  return undefined;
}

function findTopicNameIssue(value: string): string | undefined {
  const encoding = findEncodingIssue(value);
  if (encoding !== undefined) {
    return encoding;
  }
  if (value.includes(SINGLE_LEVEL_WILDCARD) || value.includes(MULTI_LEVEL_WILDCARD)) {
    return 'must not contain the wildcards "+" or "#"';
  }
  return undefined;
}

function findTopicFilterIssue(value: string): string | undefined {
  const encoding = findEncodingIssue(value);
  if (encoding !== undefined) {
    return encoding;
  }
  const levels = value.split(TOPIC_SEPARATOR);
  for (const [index, level] of levels.entries()) {
    if (level.includes(MULTI_LEVEL_WILDCARD)) {
      if (level !== MULTI_LEVEL_WILDCARD) {
        return '"#" must occupy an entire level, as in "a/#"';
      }
      if (index !== levels.length - 1) {
        return '"#" must be the last level, as in "a/#"';
      }
    }
    if (level.includes(SINGLE_LEVEL_WILDCARD) && level !== SINGLE_LEVEL_WILDCARD) {
      return '"+" must occupy an entire level, as in "a/+/b"';
    }
  }
  return undefined;
}

export function isTopicName(value: string): value is TopicName {
  return findTopicNameIssue(value) === undefined;
}

export function isTopicFilter(value: string): value is TopicFilter {
  return findTopicFilterIssue(value) === undefined;
}

/**
 * Validates a concrete topic name.
 *
 * The error reports the length but not the topic itself: topic names come from devices and
 * can carry personal data, which must not end up in logs (ADR-0004).
 */
export function parseTopicName(value: string): TopicName {
  if (isTopicName(value)) {
    return value;
  }
  throw new ValidationError(
    'INVALID_TOPIC',
    `Invalid topic name: it ${findTopicNameIssue(value) ?? 'is invalid'}.`,
    { details: { length: value.length } },
  );
}

/** Validates a subscription filter. Filters come from configuration or an agent, so the
 * offending value is reported to make the mistake fixable. */
export function parseTopicFilter(value: string): TopicFilter {
  if (isTopicFilter(value)) {
    return value;
  }
  throw new ValidationError(
    'INVALID_TOPIC',
    `Invalid topic filter: it ${findTopicFilterIssue(value) ?? 'is invalid'}.`,
    { details: { filter: value } },
  );
}

/** Levels of a topic or filter. `a//b` has three levels, the middle one empty. */
export function topicLevels(value: TopicName | TopicFilter): readonly string[] {
  return value.split(TOPIC_SEPARATOR);
}

/** A `$`-prefixed topic, such as `$SYS/broker/uptime`, which wildcards do not reach. */
export function isSystemTopic(value: TopicName): boolean {
  return value.startsWith(SYSTEM_TOPIC_PREFIX);
}

function isWildcardLevel(level: string | undefined): boolean {
  return level === SINGLE_LEVEL_WILDCARD || level === MULTI_LEVEL_WILDCARD;
}

/** A first level that pins the match to a `$` tree, such as `$SYS`. */
function isSystemLevel(level: string | undefined): boolean {
  return level?.startsWith(SYSTEM_TOPIC_PREFIX) ?? false;
}

/** MQTT-4.7.2-1: a leading wildcard never reaches `$` topics. */
function wildcardExcludesSystemTopic(filterLevels: readonly string[], topic: string): boolean {
  return isWildcardLevel(filterLevels[0]) && topic.startsWith(SYSTEM_TOPIC_PREFIX);
}

export function matchesTopic(filter: TopicFilter, topic: TopicName): boolean {
  const filterParts = filter.split(TOPIC_SEPARATOR);
  if (wildcardExcludesSystemTopic(filterParts, topic)) {
    return false;
  }
  const topicParts = topic.split(TOPIC_SEPARATOR);

  let consumed = 0;
  for (const level of filterParts) {
    if (level === MULTI_LEVEL_WILDCARD) {
      // Matches every remaining level, and the parent level when none remain.
      return true;
    }
    if (consumed >= topicParts.length) {
      return false;
    }
    if (level !== SINGLE_LEVEL_WILDCARD && level !== topicParts[consumed]) {
      return false;
    }
    consumed += 1;
  }
  return consumed === topicParts.length;
}

function coversLevels(outer: readonly string[], inner: readonly string[]): boolean {
  const [outerHead, ...outerTail] = outer;
  const [innerHead, ...innerTail] = inner;

  if (outerHead === undefined) {
    return innerHead === undefined;
  }
  if (outerHead === MULTI_LEVEL_WILDCARD) {
    return true;
  }
  if (innerHead === undefined || innerHead === MULTI_LEVEL_WILDCARD) {
    // `inner` still matches deeper topics that `outer` cannot reach.
    return false;
  }
  if (outerHead !== SINGLE_LEVEL_WILDCARD && outerHead !== innerHead) {
    return false;
  }
  return coversLevels(outerTail, innerTail);
}

/**
 * True when every topic matched by `inner` is also matched by `outer`.
 *
 * This is what lets the subscription manager keep a minimal set of broker-side
 * subscriptions: `a/#` covers `a/b/+`, so subscribing to both is redundant.
 */
export function coversFilter(outer: TopicFilter, inner: TopicFilter): boolean {
  const outerLevels = outer.split(TOPIC_SEPARATOR);
  const innerLevels = inner.split(TOPIC_SEPARATOR);
  // `#` cannot cover `$SYS/#`: the topics `$SYS/#` matches all start with `$`.
  if (isWildcardLevel(outerLevels[0]) && isSystemLevel(innerLevels[0])) {
    return false;
  }
  return coversLevels(outerLevels, innerLevels);
}

function intersectsLevels(left: readonly string[], right: readonly string[]): boolean {
  const [leftHead, ...leftTail] = left;
  const [rightHead, ...rightTail] = right;

  if (leftHead === MULTI_LEVEL_WILDCARD || rightHead === MULTI_LEVEL_WILDCARD) {
    // `#` absorbs whatever the other side still requires, including nothing at all.
    return true;
  }
  if (leftHead === undefined || rightHead === undefined) {
    return leftHead === rightHead;
  }
  if (
    leftHead !== SINGLE_LEVEL_WILDCARD &&
    rightHead !== SINGLE_LEVEL_WILDCARD &&
    leftHead !== rightHead
  ) {
    return false;
  }
  return intersectsLevels(leftTail, rightTail);
}

/**
 * True when at least one topic is matched by both filters.
 *
 * The read policy needs it: a subscription that merely overlaps a deny rule is allowed,
 * but its matching messages are dropped at ingest (ADR-0004).
 */
export function filtersIntersect(left: TopicFilter, right: TopicFilter): boolean {
  const leftLevels = left.split(TOPIC_SEPARATOR);
  const rightLevels = right.split(TOPIC_SEPARATOR);
  if (isWildcardLevel(leftLevels[0]) && isSystemLevel(rightLevels[0])) {
    return false;
  }
  if (isWildcardLevel(rightLevels[0]) && isSystemLevel(leftLevels[0])) {
    return false;
  }
  return intersectsLevels(leftLevels, rightLevels);
}

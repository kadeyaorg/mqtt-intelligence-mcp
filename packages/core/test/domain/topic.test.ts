import { describe, expect, it } from 'vitest';
import {
  coversFilter,
  filtersIntersect,
  isSystemTopic,
  isTopicFilter,
  isTopicName,
  matchesTopic,
  MAX_TOPIC_BYTES,
  parseTopicFilter,
  parseTopicName,
  topicLevels,
  ValidationError,
} from '../../src/index.js';

const name = parseTopicName;
const filter = parseTopicFilter;

describe('topic names', () => {
  it.each([
    ['single level', 'a'],
    ['several levels', 'sport/tennis/player1'],
    ['leading separator, an empty first level', '/a'],
    ['trailing separator, an empty last level', 'a/'],
    ['empty level in the middle', 'a//b'],
    ['a single space', ' '],
    ['uppercase, since topics are case sensitive', 'Sport'],
    ['a system topic', '$SYS/broker/uptime'],
    ['a level named like a JavaScript prototype key', 'a/__proto__/b'],
    ['non-ASCII characters', 'usine/température/°C'],
    ['the maximum encoded length', 'a'.repeat(MAX_TOPIC_BYTES)],
  ])('accepts %s', (_case, value) => {
    expect(isTopicName(value)).toBe(true);
    expect(parseTopicName(value)).toBe(value);
  });

  it.each([
    ['the empty string', ''],
    ['a multi-level wildcard', '#'],
    ['a single-level wildcard', '+'],
    ['a wildcard anywhere inside', 'a/#'],
    ['a wildcard character inside a level', 'a/b+c'],
    ['a null character', 'a\u0000b'],
    ['an unpaired surrogate', 'a\uD800b'],
    ['more than the maximum encoded length', 'a'.repeat(MAX_TOPIC_BYTES + 1)],
    ['the maximum length exceeded by multi-byte characters', 'é'.repeat(MAX_TOPIC_BYTES)],
  ])('rejects %s', (_case, value) => {
    expect(isTopicName(value)).toBe(false);
    expect(() => parseTopicName(value)).toThrow(ValidationError);
  });

  it('reports INVALID_TOPIC without echoing the topic, which may carry personal data', () => {
    try {
      parseTopicName('a\u0000b');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.code).toBe('INVALID_TOPIC');
      expect(validationError.message).not.toContain('a\u0000b');
      expect(validationError.details).toEqual({ length: 3 });
    }
  });

  it('splits into levels, keeping empty ones', () => {
    expect(topicLevels(name('a//b/'))).toEqual(['a', '', 'b', '']);
    expect(topicLevels(name('a'))).toEqual(['a']);
    expect(topicLevels(name('/'))).toEqual(['', '']);
  });

  it('recognises system topics', () => {
    expect(isSystemTopic(name('$SYS/broker'))).toBe(true);
    expect(isSystemTopic(name('a/$SYS'))).toBe(false);
  });
});

describe('topic filters', () => {
  it.each([
    ['everything', '#'],
    ['one level', '+'],
    ['a subtree', 'sport/#'],
    ['a wildcard level', 'sport/+/player1'],
    ['consecutive wildcards', '+/+'],
    ['a wildcard after an empty level', '/+'],
    ['both wildcards', 'a/+/#'],
    ['a system subtree', '$SYS/#'],
    ['a concrete topic, which is also a valid filter', 'sport/tennis/player1'],
  ])('accepts %s', (_case, value) => {
    expect(isTopicFilter(value)).toBe(true);
    expect(parseTopicFilter(value)).toBe(value);
  });

  it.each([
    ['the empty string', ''],
    ['"#" not alone in its level', 'sport/tennis#'],
    ['"#" not in the last level', 'sport/#/ranking'],
    ['"#" followed by anything', '#/a'],
    ['"#" with a prefix inside the level', 'a/#b'],
    ['"+" not alone in its level', 'sport+'],
    ['"+" with a suffix inside the level', 'a/b+'],
    ['a null character', 'a\u0000b'],
  ])('rejects %s', (_case, value) => {
    expect(isTopicFilter(value)).toBe(false);
    expect(() => parseTopicFilter(value)).toThrow(ValidationError);
  });
});

describe('matchesTopic', () => {
  // The first block is taken from the MQTT 5 specification, section 4.7.
  it.each([
    ['sport/tennis/+', 'sport/tennis/player1', true],
    ['sport/tennis/+', 'sport/tennis/player2', true],
    ['sport/tennis/+', 'sport/tennis/player1/ranking', false],
    ['sport/+', 'sport', false],
    ['sport/+', 'sport/', true],
    ['+/+', '/finance', true],
    ['/+', '/finance', true],
    ['+', '/finance', false],
    ['sport/tennis/player1/#', 'sport/tennis/player1', true],
    ['sport/tennis/player1/#', 'sport/tennis/player1/ranking', true],
    ['sport/tennis/player1/#', 'sport/tennis/player1/score/wimbledon', true],
    ['sport/#', 'sport', true],
    ['#', 'a/b/c', true],
    // MQTT-4.7.2-1: a leading wildcard does not reach $ topics.
    ['#', '$SYS/broker/uptime', false],
    ['+/monitor/Clients', '$SYS/monitor/Clients', false],
    ['$SYS/#', '$SYS/monitor/Clients', true],
    ['$SYS/monitor/+', '$SYS/monitor/Clients', true],
    // A $ below the first level is an ordinary character.
    ['a/+', 'a/$b', true],
    // Case sensitivity, empty levels, and the difference between `a` and `a/`.
    ['a', 'A', false],
    ['a/b', 'a/b/', false],
    ['a/+/c', 'a//c', true],
    ['a//b', 'a//b', true],
    ['a/#', 'a', true],
  ])('%s matches %s -> %s', (subscription, topic, expected) => {
    expect(matchesTopic(filter(subscription), name(topic))).toBe(expected);
  });
});

describe('coversFilter', () => {
  it.each([
    ['#', 'a/b', true],
    ['#', '#', true],
    ['#', '+', true],
    ['#', 'a/#', true],
    // The topics `$SYS/#` matches all start with $, which a leading wildcard never reaches.
    ['#', '$SYS/#', false],
    ['+', '$SYS', false],
    ['a/#', 'a', true],
    ['a/#', 'a/b/+', true],
    ['a/#', 'a/#', true],
    ['a/#', 'b/#', false],
    ['a/+', 'a/b', true],
    ['a/+', 'a/+', true],
    ['a/+', 'a/b/c', false],
    ['a/+', 'a/#', false],
    ['+/+', 'a/b', true],
    ['a/b', 'a/b', true],
    ['a/b', 'a/+', false],
    ['a', 'a/b', false],
    ['$SYS/#', '$SYS/monitor/+', true],
    ['$SYS/#', '$SYS', true],
  ])('%s covers %s -> %s', (outer, inner, expected) => {
    expect(coversFilter(filter(outer), filter(inner))).toBe(expected);
  });
});

describe('filtersIntersect', () => {
  it.each([
    ['a/#', 'a/b', true],
    ['a/#', '#', true],
    ['a/+', 'a/b/c', false],
    ['a/+', '+/b', true],
    ['+/b', 'a/+', true],
    ['a/b', 'a/c', false],
    ['a/b', 'a/b', true],
    ['a/+/c', 'a/b/d', false],
    ['+', 'a/b', false],
    ['#', 'a/b/c', true],
    ['$SYS/#', '$SYS/broker', true],
    ['#', '$SYS/#', false],
    ['$SYS/#', '#', false],
    ['a/#', 'a', true],
  ])('%s intersects %s -> %s', (left, right, expected) => {
    expect(filtersIntersect(filter(left), filter(right))).toBe(expected);
  });
});

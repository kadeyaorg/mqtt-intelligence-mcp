/**
 * Properties of the relations between filters and topics.
 *
 * The table-driven tests pin the specification's examples; these check the invariants the
 * subscription manager and the read policy rely on, over thousands of generated cases.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TopicFilter, TopicName } from '../../src/index.js';
import {
  coversFilter,
  filtersIntersect,
  matchesTopic,
  parseTopicFilter,
  parseTopicName,
} from '../../src/index.js';

/** Levels chosen from a small alphabet, including the empty level and a `$` tree. */
const literalLevel = fc.constantFrom('a', 'b', 'c', '', '$SYS');

const topicArbitrary: fc.Arbitrary<TopicName> = fc
  .array(literalLevel, { minLength: 1, maxLength: 4 })
  .map((levels) => levels.join('/'))
  .filter((value) => value.length > 0)
  .map((value) => parseTopicName(value));

const filterArbitrary: fc.Arbitrary<TopicFilter> = fc
  .tuple(
    fc.array(fc.constantFrom('a', 'b', 'c', '', '$SYS', '+'), { minLength: 0, maxLength: 3 }),
    fc.boolean(),
  )
  .map(([levels, multiLevel]) => (multiLevel ? [...levels, '#'] : levels).join('/'))
  .filter((value) => value.length > 0)
  .map((value) => parseTopicFilter(value));

/** A filter without wildcards, which is also a concrete topic. */
const concreteFilterArbitrary: fc.Arbitrary<TopicFilter> = topicArbitrary.map((topic) =>
  parseTopicFilter(topic),
);

describe('filter relations', () => {
  it('covers is reflexive', () => {
    fc.assert(
      fc.property(filterArbitrary, (subject) => {
        expect(coversFilter(subject, subject)).toBe(true);
      }),
    );
  });

  it('covers is sound: whatever the inner filter matches, the outer one matches too', () => {
    fc.assert(
      fc.property(filterArbitrary, filterArbitrary, topicArbitrary, (outer, inner, topic) => {
        fc.pre(coversFilter(outer, inner));
        fc.pre(matchesTopic(inner, topic));
        expect(matchesTopic(outer, topic)).toBe(true);
      }),
    );
  });

  it('covers implies a non-empty intersection', () => {
    fc.assert(
      fc.property(filterArbitrary, filterArbitrary, (outer, inner) => {
        fc.pre(coversFilter(outer, inner));
        expect(filtersIntersect(outer, inner)).toBe(true);
      }),
    );
  });

  it('intersection is symmetric', () => {
    fc.assert(
      fc.property(filterArbitrary, filterArbitrary, (left, right) => {
        expect(filtersIntersect(left, right)).toBe(filtersIntersect(right, left));
      }),
    );
  });

  it('intersection is reflexive, since every filter matches at least one topic', () => {
    fc.assert(
      fc.property(filterArbitrary, (subject) => {
        expect(filtersIntersect(subject, subject)).toBe(true);
      }),
    );
  });

  it('covering a wildcard-free filter is the same as matching that topic', () => {
    fc.assert(
      fc.property(filterArbitrary, concreteFilterArbitrary, (outer, concrete) => {
        const topic = parseTopicName(concrete);
        expect(coversFilter(outer, concrete)).toBe(matchesTopic(outer, topic));
      }),
    );
  });

  it('a matched topic intersects the filter that matched it', () => {
    fc.assert(
      fc.property(filterArbitrary, topicArbitrary, (subject, topic) => {
        fc.pre(matchesTopic(subject, topic));
        expect(filtersIntersect(subject, parseTopicFilter(topic))).toBe(true);
      }),
    );
  });

  it('covers is transitive', () => {
    fc.assert(
      fc.property(filterArbitrary, filterArbitrary, filterArbitrary, (outer, middle, inner) => {
        fc.pre(coversFilter(outer, middle));
        fc.pre(coversFilter(middle, inner));
        expect(coversFilter(outer, inner)).toBe(true);
      }),
    );
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TopicFilter, TopicName } from '../../src/index.js';
import {
  coversFilter,
  createReadPolicy,
  filtersIntersect,
  matchesTopic,
  parseTopicFilter,
  parseTopicName,
} from '../../src/index.js';

const level = fc.constantFrom('a', 'b', 'c', '$SYS');

const topicArbitrary: fc.Arbitrary<TopicName> = fc
  .array(level, { minLength: 1, maxLength: 3 })
  .map((levels) => parseTopicName(levels.join('/')));

const filterArbitrary: fc.Arbitrary<TopicFilter> = fc
  .tuple(
    fc.array(fc.constantFrom('a', 'b', 'c', '$SYS', '+'), { minLength: 0, maxLength: 2 }),
    fc.boolean(),
  )
  .map(([levels, multiLevel]) => (multiLevel ? [...levels, '#'] : levels).join('/'))
  .filter((value) => value.length > 0)
  .map((value) => parseTopicFilter(value));

const rulesArbitrary = fc.record({
  allow: fc.array(filterArbitrary, { maxLength: 3 }),
  deny: fc.array(filterArbitrary, { maxLength: 2 }),
});

describe('read policy properties', () => {
  it('reads a topic exactly when an allow rule matches it and no deny rule does', () => {
    fc.assert(
      fc.property(rulesArbitrary, topicArbitrary, (rules, topic) => {
        const policy = createReadPolicy(rules);

        const expected =
          rules.allow.some((allowed) => matchesTopic(allowed, topic)) &&
          !rules.deny.some((denied) => matchesTopic(denied, topic));

        expect(policy.isReadable(topic)).toBe(expected);
      }),
    );
  });

  it('never subscribes outside what was requested', () => {
    fc.assert(
      fc.property(rulesArbitrary, filterArbitrary, topicArbitrary, (rules, request, topic) => {
        const decision = createReadPolicy(rules).checkSubscribe(request);
        fc.pre(decision.outcome === 'allowed');
        fc.pre(decision.filters.some((filter) => matchesTopic(filter, topic)));

        expect(matchesTopic(request, topic)).toBe(true);
      }),
    );
  });

  it('never subscribes to a filter that lies entirely inside a deny rule', () => {
    fc.assert(
      fc.property(rulesArbitrary, filterArbitrary, (rules, request) => {
        const decision = createReadPolicy(rules).checkSubscribe(request);
        fc.pre(decision.outcome === 'allowed');
        for (const filter of decision.filters) {
          expect(rules.deny.some((denied) => coversFilter(denied, filter))).toBe(false);
        }
      }),
    );
  });

  it('reports the deny rules that overlap what it subscribes to', () => {
    fc.assert(
      fc.property(rulesArbitrary, filterArbitrary, (rules, request) => {
        const decision = createReadPolicy(rules).checkSubscribe(request);
        fc.pre(decision.outcome === 'allowed');
        const overlapping = rules.deny.filter((denied) =>
          decision.filters.some((filter) => filtersIntersect(denied, filter)),
        );

        expect([...decision.filteredByDeny]).toEqual(overlapping);
      }),
    );
  });

  it('leaves the request untouched when it is not narrowed', () => {
    fc.assert(
      fc.property(rulesArbitrary, filterArbitrary, (rules, request) => {
        const decision = createReadPolicy(rules).checkSubscribe(request);
        fc.pre(decision.outcome === 'allowed');
        fc.pre(!decision.narrowed);

        expect(decision.filters).toEqual([request]);
      }),
    );
  });
});

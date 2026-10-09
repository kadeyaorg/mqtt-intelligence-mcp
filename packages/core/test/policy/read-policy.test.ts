/**
 * Security suite for the read policy.
 *
 * These are the assertions that keep the engine honest about what an agent may observe, so
 * they are written as cases an operator would recognise, not as unit trivia.
 */
import { describe, expect, it } from 'vitest';
import type { ReadPolicy, SubscribeDecision } from '../../src/index.js';
import { createReadPolicy, parseTopicFilter, parseTopicName } from '../../src/index.js';

const filters = (...values: string[]) => values.map((value) => parseTopicFilter(value));

function policyOf(allow: string[], deny: string[] = []): ReadPolicy {
  return createReadPolicy({ allow: filters(...allow), deny: filters(...deny) });
}

function subscribe(policy: ReadPolicy, filter: string): SubscribeDecision {
  return policy.checkSubscribe(parseTopicFilter(filter));
}

function readable(policy: ReadPolicy, topic: string): boolean {
  return policy.isReadable(parseTopicName(topic));
}

describe('reading a topic', () => {
  it('allows everything outside $ trees by default', () => {
    const policy = policyOf(['#']);

    expect(readable(policy, 'factory/line-01/robot/status')).toBe(true);
    expect(readable(policy, 'a')).toBe(true);
  });

  it('never matches a $ tree with a wildcard, as MQTT requires', () => {
    expect(readable(policyOf(['#']), '$SYS/broker/uptime')).toBe(false);
    expect(readable(policyOf(['+/broker/uptime']), '$SYS/broker/uptime')).toBe(false);
    expect(readable(policyOf(['$SYS/#']), '$SYS/broker/uptime')).toBe(true);
  });

  it('refuses a denied topic even when an allow rule matches it', () => {
    const policy = policyOf(['#'], ['factory/+/secrets/#']);

    expect(readable(policy, 'factory/line-01/robot/status')).toBe(true);
    expect(readable(policy, 'factory/line-01/secrets/token')).toBe(false);
    expect(readable(policy, 'factory/line-01/secrets')).toBe(false);
  });

  it('refuses everything when the allow list is empty', () => {
    const policy = policyOf([], []);

    expect(readable(policy, 'anything')).toBe(false);
    expect(readable(policy, 'factory/line-01')).toBe(false);
  });

  it('reads only what the allow list covers', () => {
    const policy = policyOf(['factory/#', 'plant/+/status']);

    expect(readable(policy, 'factory/line-01/robot')).toBe(true);
    expect(readable(policy, 'plant/a/status')).toBe(true);
    expect(readable(policy, 'plant/a/status/extra')).toBe(false);
    expect(readable(policy, 'warehouse/temp')).toBe(false);
  });
});

describe('subscribing', () => {
  it('allows a filter the allow list covers, and asks for it as is', () => {
    const decision = subscribe(policyOf(['factory/#']), 'factory/line-01/#');

    expect(decision).toEqual({
      outcome: 'allowed',
      filters: ['factory/line-01/#'],
      narrowed: false,
      filteredByDeny: [],
    });
  });

  it('narrows a request that is broader than the allow list', () => {
    const decision = subscribe(policyOf(['factory/#', 'plant/#']), '#');

    expect(decision).toEqual({
      outcome: 'allowed',
      filters: ['factory/#', 'plant/#'],
      narrowed: true,
      filteredByDeny: [],
    });
  });

  it('refuses a request fully inside a deny rule', () => {
    const decision = subscribe(policyOf(['#'], ['factory/secrets/#']), 'factory/secrets/line-01/#');

    expect(decision).toEqual({
      outcome: 'denied',
      reason: '"factory/secrets/line-01/#" is inside the deny rule "factory/secrets/#".',
    });
  });

  it('allows a request that merely overlaps a deny rule, and reports the filtering', () => {
    const decision = subscribe(policyOf(['#'], ['factory/+/secrets/#']), 'factory/#');

    expect(decision).toEqual({
      outcome: 'allowed',
      filters: ['factory/#'],
      narrowed: false,
      filteredByDeny: ['factory/+/secrets/#'],
    });
  });

  it('does not narrow onto an allowed sub-tree that is entirely denied', () => {
    const decision = subscribe(policyOf(['factory/#', 'plant/#'], ['plant/#']), '#');

    expect(decision).toEqual({
      outcome: 'allowed',
      filters: ['factory/#'],
      narrowed: true,
      filteredByDeny: [],
    });
  });

  it('refuses a filter outside the allow list', () => {
    const decision = subscribe(policyOf(['factory/#']), 'warehouse/#');

    expect(decision.outcome).toBe('denied');
    expect(decision.outcome === 'denied' && decision.reason).toContain(
      'outside the read allow list',
    );
  });

  it('refuses a filter that only partly overlaps, and says what to ask instead', () => {
    const decision = subscribe(policyOf(['+/line-01/#']), 'factory/+/robot/#');

    expect(decision.outcome).toBe('denied');
    expect(decision.outcome === 'denied' && decision.reason).toContain('only partly overlaps');
  });

  it('refuses everything when the allow list is empty, and says so', () => {
    const decision = subscribe(policyOf([]), '#');

    expect(decision).toEqual({
      outcome: 'denied',
      reason: '"#" is not allowed: the read allow list is empty.',
    });
  });
});

describe('$SYS trees', () => {
  it('refuses $SYS under a default allow list, and says exactly what to add', () => {
    const decision = subscribe(policyOf(['#']), '$SYS/#');

    expect(decision.outcome).toBe('denied');
    expect(decision.outcome === 'denied' && decision.reason).toContain(
      'Add "$SYS/#" to security.read.allow',
    );
  });

  it('allows $SYS once it is allowed explicitly', () => {
    const decision = subscribe(policyOf(['#', '$SYS/#']), '$SYS/#');

    expect(decision).toEqual({
      outcome: 'allowed',
      filters: ['$SYS/#'],
      narrowed: false,
      filteredByDeny: [],
    });
  });

  it('never narrows "#" onto a $ tree, since "#" could not reach it anyway', () => {
    const decision = subscribe(policyOf(['factory/#', '$SYS/#']), '#');

    expect(decision.outcome === 'allowed' && decision.filters).toEqual(['factory/#']);
  });
});

describe('the deny rule always wins', () => {
  it.each([
    ['an exact topic', ['#'], ['factory/line-01/robot/status'], 'factory/line-01/robot/status'],
    ['a sub-tree', ['#'], ['factory/line-01/#'], 'factory/line-01/robot/status'],
    ['a wildcard level', ['#'], ['factory/+/robot/status'], 'factory/line-01/robot/status'],
    ['a deny rule broader than the allow rule', ['factory/#'], ['#'], 'factory/line-01/robot'],
    ['a parent matched by "#"', ['#'], ['factory/#'], 'factory'],
  ])('refuses a topic denied by %s', (_case, allow, deny, topic) => {
    expect(readable(policyOf(allow, deny), topic)).toBe(false);
  });

  it('still reads a $ tree that a second allow rule opens', () => {
    // Found by the property suite: the shortcut for `allow: ["#"]` used to refuse these.
    const policy = policyOf(['#', '$SYS/#']);

    expect(readable(policy, '$SYS/broker/uptime')).toBe(true);
    expect(readable(policy, 'factory/line-01')).toBe(true);
  });

  it('keeps the fast path honest: denying anything disables it', () => {
    const permissive = policyOf(['#']);
    const restricted = policyOf(['#'], ['secret/#']);

    expect(readable(permissive, 'secret/a')).toBe(true);
    expect(readable(restricted, 'secret/a')).toBe(false);
    expect(readable(restricted, 'public/a')).toBe(true);
  });
});

describe('the policy is a snapshot', () => {
  it('ignores later mutation of the arrays it was given', () => {
    const deny = filters('secret/#');
    const policy = createReadPolicy({ allow: filters('#'), deny });

    deny.length = 0;

    expect(readable(policy, 'secret/a')).toBe(false);
    expect(policy.rules.deny).toEqual(['secret/#']);
  });
});

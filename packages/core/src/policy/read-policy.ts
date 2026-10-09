/**
 * The read policy: the single place that decides what may be observed (ADR-0004).
 *
 * Two questions, asked at two different moments:
 *
 * - **Before subscribing**, {@link ReadPolicy.checkSubscribe} decides whether a filter may
 *   be requested from the broker, and narrows it when the allow list is more restrictive
 *   than the request.
 * - **On every message**, {@link ReadPolicy.isReadable} decides whether a topic may be
 *   counted, stored and shown. A subscription that merely *overlaps* a deny rule is allowed,
 *   and its denied messages are dropped here, on arrival.
 *
 * A deny rule always wins. Rules are MQTT topic filters, with MQTT semantics, which means
 * `allow: ["#"]` deliberately does **not** grant `$SYS`: broker-internal trees must be
 * allowed explicitly, exactly as a broker requires them to be subscribed explicitly.
 */
import type { TopicFilter, TopicName } from '../domain/topic.js';
import {
  coversFilter,
  filtersIntersect,
  matchesTopic,
  MULTI_LEVEL_WILDCARD,
  SYSTEM_TOPIC_PREFIX,
} from '../domain/topic.js';

export interface ReadRules {
  /** Filters that may be read. An empty list allows nothing. */
  readonly allow: readonly TopicFilter[];
  /** Filters that may never be read, whatever the allow list says. */
  readonly deny: readonly TopicFilter[];
}

export type SubscribeDecision =
  | {
      readonly outcome: 'allowed';
      /**
       * What should actually be subscribed to. Equal to the request, unless the allow list
       * is narrower, in which case it holds the allowed sub-trees instead.
       */
      readonly filters: readonly TopicFilter[];
      readonly narrowed: boolean;
      /** Deny rules that overlap: their messages must be dropped at ingest. */
      readonly filteredByDeny: readonly TopicFilter[];
    }
  | { readonly outcome: 'denied'; readonly reason: string };

export interface ReadPolicy {
  readonly rules: ReadRules;
  /** May this concrete topic be counted, stored and shown? */
  isReadable(topic: TopicName): boolean;
  /** May this filter be subscribed to, and in what form? */
  checkSubscribe(filter: TopicFilter): SubscribeDecision;
}

function listFilters(filters: readonly TopicFilter[]): string {
  return filters.map((filter) => `"${filter}"`).join(', ');
}

class CompiledReadPolicy implements ReadPolicy {
  readonly rules: ReadRules;
  /** `allow: ["#"]` with no deny rule is the default: answer without walking any list. */
  readonly #allowsEverythingOutsideSystemTrees: boolean;

  constructor(rules: ReadRules) {
    this.rules = { allow: [...rules.allow], deny: [...rules.deny] };
    this.#allowsEverythingOutsideSystemTrees =
      this.rules.deny.length === 0 &&
      this.rules.allow.some((filter) => filter === MULTI_LEVEL_WILDCARD) &&
      // A rule such as "$SYS/#" opens a tree the shortcut would wrongly refuse: only the
      // first level of a filter can reach a $ topic.
      !this.rules.allow.some((filter) => filter.startsWith(SYSTEM_TOPIC_PREFIX));
  }

  isReadable(topic: TopicName): boolean {
    if (this.#allowsEverythingOutsideSystemTrees) {
      return !topic.startsWith(SYSTEM_TOPIC_PREFIX);
    }
    for (const denied of this.rules.deny) {
      if (matchesTopic(denied, topic)) {
        return false;
      }
    }
    for (const allowed of this.rules.allow) {
      if (matchesTopic(allowed, topic)) {
        return true;
      }
    }
    return false;
  }

  checkSubscribe(filter: TopicFilter): SubscribeDecision {
    // A request entirely inside a deny rule can never yield a readable message.
    const blocking = this.rules.deny.find((denied) => coversFilter(denied, filter));
    if (blocking !== undefined) {
      return {
        outcome: 'denied',
        reason: `"${filter}" is inside the deny rule "${blocking}".`,
      };
    }

    const covering = this.rules.allow.some((allowed) => coversFilter(allowed, filter));
    const filters = covering ? [filter] : this.#narrow(filter);

    if (filters.length === 0) {
      return { outcome: 'denied', reason: this.#explainRefusal(filter) };
    }

    const filteredByDeny = this.rules.deny.filter((denied) =>
      filters.some((effective) => filtersIntersect(denied, effective)),
    );

    return {
      outcome: 'allowed',
      filters,
      narrowed: !covering,
      filteredByDeny,
    };
  }

  /**
   * When the request is broader than the allow list, subscribe to the allowed sub-trees
   * instead, so that denied traffic never even reaches this process.
   *
   * Only allow rules the request fully covers are usable: a partial overlap would need an
   * intersection filter, which MQTT cannot always express, so it is refused instead.
   */
  #narrow(filter: TopicFilter): readonly TopicFilter[] {
    return this.rules.allow.filter(
      (allowed) =>
        coversFilter(filter, allowed) &&
        !this.rules.deny.some((denied) => coversFilter(denied, allowed)),
    );
  }

  #explainRefusal(filter: TopicFilter): string {
    if (this.rules.allow.length === 0) {
      return `"${filter}" is not allowed: the read allow list is empty.`;
    }
    if (
      filter.startsWith(SYSTEM_TOPIC_PREFIX) &&
      !this.rules.allow.some((allowed) => allowed.startsWith(SYSTEM_TOPIC_PREFIX))
    ) {
      return `"${filter}" is not allowed: wildcards never match $-prefixed topics, so a broker-internal tree must be allowed explicitly. Add "${filter}" to security.read.allow.`;
    }
    if (this.rules.allow.some((allowed) => filtersIntersect(allowed, filter))) {
      return `"${filter}" only partly overlaps the read allow list (${listFilters(this.rules.allow)}); request a filter that is inside one of them, or that contains one.`;
    }
    return `"${filter}" is outside the read allow list (${listFilters(this.rules.allow)}).`;
  }
}

export function createReadPolicy(rules: ReadRules): ReadPolicy {
  return new CompiledReadPolicy(rules);
}

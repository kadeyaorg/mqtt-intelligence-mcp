# Changelog

## 0.2.0

### Minor Changes

- [#21](https://github.com/kadeyaorg/mqtt-intelligence-mcp/pull/21) [`bd6d9b2`](https://github.com/kadeyaorg/mqtt-intelligence-mcp/commit/bd6d9b204ffc5874da8277f028ba05fc0d191be2) Thanks [@christophe77](https://github.com/christophe77)! - First release.

  An MCP server, and a Node.js library, giving an AI agent read-only, structured and observable
  access to MQTT brokers.

  - Six read-only MCP tools: list brokers, discover topics, topic tree, search, describe a
    topic, recent messages. No publish path exists.
  - Multi-broker: MQTT 3.1.1 and 5, TLS and mutual TLS, WebSockets, independent connections
    with their own credentials, policy and reconnection.
  - Passive discovery with a bounded topic catalogue, per-topic statistics, and explicit
    observation coverage: every answer says what the server could not see.
  - Payload classification and safe views: JSON, text, number, boolean and binary, truncated,
    escaped and redacted before an agent sees them.
  - A read policy where deny beats allow, applied at ingest: a denied topic is never stored,
    counted or listed.
  - A `mqtt-intelligence-mcp` command: `serve` over stdio, and `check` to validate a configuration and
    test every broker before wiring it to an agent.

- [#35](https://github.com/kadeyaorg/mqtt-intelligence-mcp/pull/35) [`12c81d9`](https://github.com/kadeyaorg/mqtt-intelligence-mcp/commit/12c81d9b7388dd549c91b60c427c0394cb772f67) Thanks [@christophe77](https://github.com/christophe77)! - A topic's shape now carries when each field was first and last seen, so a change becomes visible.

  `mqtt_infer_schema` and `mqtt_describe_topic` report positions whose observation window does
  not match the topic's: a field that stopped appearing, one that started. A renamed field shows
  up as the old name ending and the new one beginning at the same moment.

  It reports two dated facts, not a rename. Two unrelated changes look identical from arrival
  times, and only someone who knows the firmware can tell which it was. A window too short to
  compare against reports nothing, because everything in it is equally new.

  The timestamps are a first-and-last pair per position, merged by minimum and maximum, so they
  survive batching like every other statistic. `observeJson` now takes the receipt time as a
  required argument: a timestamp quietly defaulted would make every change report wrong without
  ever failing.

- [#32](https://github.com/kadeyaorg/mqtt-intelligence-mcp/pull/32) [`73abd1c`](https://github.com/kadeyaorg/mqtt-intelligence-mcp/commit/73abd1cf39c1b96b3a44e617ce116dbf84e2292b) Thanks [@christophe77](https://github.com/christophe77)! - `mqtt_describe_topic` now reports when a topic's gaps fall into more than one group.

  A mean and a standard deviation can say a topic is irregular; they cannot say how. A topic
  published once per cycle and one published twice per cycle both come out "irregular", and only
  the second has two populations of gaps — a short one inside the cycle, a long one between
  cycles. The observation now names them: "intervals fall into 2 groups: 64 ms–256 ms (20),
  1.0 s–2.0 s (19)".

  It reports the shape and not the cause. Two publishers, one loop publishing twice and a retry
  all look identical from arrival times alone, so the answer says so rather than choosing.

  Inter-arrival times are counted into twenty power-of-two buckets per topic, merged
  element-wise like every other statistic, and absent until a topic has a second live message.

- [#39](https://github.com/kadeyaorg/mqtt-intelligence-mcp/pull/39) [`9609928`](https://github.com/kadeyaorg/mqtt-intelligence-mcp/commit/9609928c9803c4d84089c438b52c424cf4eae3e7) Thanks [@christophe77](https://github.com/christophe77)! - Payloads the classifier can only call binary can now be read by a registered decoder.

  Classification reads bytes and nothing else, so Sparkplug B, protobuf, CBOR and every other
  framed format come out as a size, a hex preview and a digest. That is honest and useless to
  anyone whose plant speaks Sparkplug.

  `createEngine(config, { decoders })` closes the gap from outside. No decoder ships here and
  none will: each carries a dependency or a specification of its own, and the core stays
  format-agnostic. What ships is the contract — synchronous, may throw, `undefined` means "not
  mine", must not retain the buffer, must not reach the network — and each clause says why.

  A decoder's output is treated exactly as parsed JSON: bounded, redacted, given a safe view,
  folded into the topic's inferred shape. The one difference is that every answer names the
  decoder, because a reader who takes decoded bytes for JSON will write a consumer that breaks
  on the real wire format. A decoder that throws is counted and stepped over; one broken
  extension does not take a namespace's ingestion with it.

- [#34](https://github.com/kadeyaorg/mqtt-intelligence-mcp/pull/34) [`f9f40f4`](https://github.com/kadeyaorg/mqtt-intelligence-mcp/commit/f9f40f4c6e879fb0b7c7e609709e202ad4c6d66f) Thanks [@christophe77](https://github.com/christophe77)! - A seventh tool, `mqtt_infer_schema`, and the shape of a topic's payloads in `mqtt_describe_topic`.

  The shape is inferred from the payloads ingestion was already parsing, so it costs no extra
  parse and obeys the same inspection budget. `mqtt_infer_schema` returns a JSON Schema ready to
  export; `mqtt_describe_topic` carries the same shape as a flat field list, so one call answers
  "what is this topic".

  Fields report the share of payloads that carried them rather than the word "optional":
  "in 25% of payloads" is a fact about what arrived, "optional" is a claim about intent. The
  answer says how many payloads are behind the shape, and `SCHEMA_TRUNCATED` appears in the
  limitations when a limit stopped inference inside the payload.

- [#37](https://github.com/kadeyaorg/mqtt-intelligence-mcp/pull/37) [`669934a`](https://github.com/kadeyaorg/mqtt-intelligence-mcp/commit/669934ab773704e9a08615feb2cf42cb7acf4f93) Thanks [@christophe77](https://github.com/christophe77)! - `mqtt_search_topics` answers "what is new" with `firstSeenSinceMs`, and time filters now use the engine's clock.

  The activity story is complete in one tool rather than a second one: sort by `rate` for the
  busiest, `silentForMs` for what stopped, `firstSeenSinceMs` for what is new. ADR-0020 records
  why `mqtt_get_activity` was dropped instead of built — two thirds of it duplicated search, and
  the duplication is the cost.

  "First seen" means first seen by this server, not first published, and the tool description
  says so: a topic that has existed for years looks new the first time we are watching when it
  publishes.

  **Fixed:** the MCP adapter converted durations to instants with its own wall clock, so an
  engine running on any other clock — a test, a replay — was asked about a moment it had never
  been at and returned nothing. `searchTopics` now takes durations and converts them with the
  engine's clock; the adapter reads no clock at all. `activeSince` and `silentSince` on
  `SearchTopicsRequest` become `activeWithinMs` and `silentForMs`.

- [#35](https://github.com/kadeyaorg/mqtt-intelligence-mcp/pull/35) [`12c81d9`](https://github.com/kadeyaorg/mqtt-intelligence-mcp/commit/12c81d9b7388dd549c91b60c427c0394cb772f67) Thanks [@christophe77](https://github.com/christophe77)! - `mqtt_topic_tree` folds sibling branches whose names differ only in a number or an identifier.

  `f1` to `f4` become `f#`; five thousand device ids become `device-#`. A tree listing them one
  by one says nothing a reader can hold, while the shape says the system is keyed by device id —
  which is the fact they were after.

  The fold is always reported with the number of branches behind it, the counts aggregate
  everything it covers, and the subtree below is merged rather than lost. Three distinct
  siblings are needed before anything folds, because two is not a pattern, and
  `foldPatterns: false` shows every branch as published.

  A folded segment is a shape rather than a level, so the path it appears at is not a topic
  filter and must not be used as one.

- [#37](https://github.com/kadeyaorg/mqtt-intelligence-mcp/pull/37) [`669934a`](https://github.com/kadeyaorg/mqtt-intelligence-mcp/commit/669934ab773704e9a08615feb2cf42cb7acf4f93) Thanks [@christophe77](https://github.com/christophe77)! - `mqtt_describe_topic` now lists related topics, each with the reason it is related.

  Three relations, all facts about the names: published under the same branch, ending with the
  same level, or the same name but for a number. The most specific one wins when several apply,
  since a numbered twin tells a reader more than a sibling, and a sibling more than a topic that
  merely ends the same way.

  The reason is the point. "Related" with no reason invites the assumption that the topics are
  wired together; "ends with the same level, state" is a convention a reader can weigh for
  themselves, and the answer says plainly that none of it is evidence they are connected.

  Temporal relations are deliberately not inferred. Honest co-occurrence needs per-pair state
  that grows with the square of the namespace, and of everything this server could report it is
  the one most certain to be read as cause.

- [#33](https://github.com/kadeyaorg/mqtt-intelligence-mcp/pull/33) [`4b03d5f`](https://github.com/kadeyaorg/mqtt-intelligence-mcp/commit/4b03d5fe412e2a49a737ef8e7dbdc652d9144985) Thanks [@christophe77](https://github.com/christophe77)! - Payload shapes can now be inferred from the payloads themselves, incrementally and mergeably.

  `observeJson` folds a JSON value into a schema, `mergeSchemas` combines two, and
  `toJsonSchema` exports draft 2020-12. A schema is counts rather than flags — how many values
  were seen at a position, and how many of each type — so merging is addition, optionality is
  derived from the counts instead of stored, and a union is simply more than one type above
  zero.

  An object with more than 32 distinct keys becomes a map, because such an object is keyed by
  an identifier rather than being a record with a thousand fields, and because that is what
  keeps a schema from growing with the traffic. Nesting beyond six levels stops and says so.

  Nothing is wired into the catalogue or the tools yet; that is the next step.

### Patch Changes

- [#40](https://github.com/kadeyaorg/mqtt-intelligence-mcp/pull/40) [`4868a22`](https://github.com/kadeyaorg/mqtt-intelligence-mcp/commit/4868a2272b11302711649cf53018cd5b27fffb35) Thanks [@christophe77](https://github.com/christophe77)! - Node.js 26 is now a supported runtime, tested as a blocking CI job on Linux, Windows and macOS.

  It enters Active LTS on 2026-10-28, five days after this release. ADR-0001 promotes a line
  when it enters LTS; promoting it a few days early is deliberate, so that the first published
  version advertises the runtime support that holds for the whole of its life rather than a
  window that closes the week after. Node 22 and 24 remain supported in maintenance LTS until
  April 2027 and April 2028.

  The `engines` ranges already admitted 26 and are unchanged, so nothing about installing either
  package changes; what changed is that 26 is now tested and advertised rather than merely
  permitted.

- [#23](https://github.com/kadeyaorg/mqtt-intelligence-mcp/pull/23) [`b4e5df5`](https://github.com/kadeyaorg/mqtt-intelligence-mcp/commit/b4e5df5970f20dd99fd6f1dff3aa34a2476c1e69) Thanks [@christophe77](https://github.com/christophe77)! - Retained state topics that keep publishing are reported as alive again.

  On MQTT 5, subscriptions asked for Retain As Published, so the broker forwarded the
  publisher's retain flag on every delivery. A live publish of a retained state topic was then
  indistinguishable from a replay at subscribe time, and since replays are excluded from
  liveness and rate statistics, every retained state topic read as one that had never
  published: no rate, no last-live time, absent from "what is active", and permanently listed
  under "what has gone quiet".

  Measured against a real production line, 33 of 46 actively publishing topics were affected —
  the whole PLC subtree of a machine, publishing every 1.3 seconds, reported "last live never".

  Retain As Published is now off, which is the protocol default and makes MQTT 5 behave like
  MQTT 3.1.1. A delivery marked retained once again means what the specification says it means
  on a forwarded message: replayed at subscribe time.

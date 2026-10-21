---
'@kadeya/mqtt-intel-core': minor
'@kadeya/mqtt-intel-mcp': minor
---

`mqtt_search_topics` answers "what is new" with `firstSeenSinceMs`, and time filters now use the engine's clock.

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

---
'@kadeya/mqtt-intel-core': minor
'@kadeya/mqtt-intel-mcp': minor
---

`mqtt_describe_topic` now lists related topics, each with the reason it is related.

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

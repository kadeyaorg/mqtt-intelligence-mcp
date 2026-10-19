---
'@kadeya/mqtt-intel-core': minor
'@kadeya/mqtt-intel-mcp': minor
---

`mqtt_topic_tree` folds sibling branches whose names differ only in a number or an identifier.

`f1` to `f4` become `f#`; five thousand device ids become `device-#`. A tree listing them one
by one says nothing a reader can hold, while the shape says the system is keyed by device id —
which is the fact they were after.

The fold is always reported with the number of branches behind it, the counts aggregate
everything it covers, and the subtree below is merged rather than lost. Three distinct
siblings are needed before anything folds, because two is not a pattern, and
`foldPatterns: false` shows every branch as published.

A folded segment is a shape rather than a level, so the path it appears at is not a topic
filter and must not be used as one.

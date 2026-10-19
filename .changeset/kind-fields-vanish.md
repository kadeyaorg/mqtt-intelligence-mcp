---
'@kadeya/mqtt-intel-core': minor
'@kadeya/mqtt-intel-mcp': minor
---

A topic's shape now carries when each field was first and last seen, so a change becomes visible.

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

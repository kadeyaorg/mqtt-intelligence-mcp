---
'@kadeya/mqtt-intel-core': minor
'@kadeya/mqtt-intel-mcp': minor
---

`mqtt_describe_topic` now reports when a topic's gaps fall into more than one group.

A mean and a standard deviation can say a topic is irregular; they cannot say how. A topic
published once per cycle and one published twice per cycle both come out "irregular", and only
the second has two populations of gaps — a short one inside the cycle, a long one between
cycles. The observation now names them: "intervals fall into 2 groups: 64 ms–256 ms (20),
1.0 s–2.0 s (19)".

It reports the shape and not the cause. Two publishers, one loop publishing twice and a retry
all look identical from arrival times alone, so the answer says so rather than choosing.

Inter-arrival times are counted into twenty power-of-two buckets per topic, merged
element-wise like every other statistic, and absent until a topic has a second live message.

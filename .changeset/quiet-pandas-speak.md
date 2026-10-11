---
'@kadeya/mqtt-intel-core': patch
---

Retained state topics that keep publishing are reported as alive again.

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

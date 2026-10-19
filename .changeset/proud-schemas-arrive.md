---
'@kadeya/mqtt-intel-core': minor
'@kadeya/mqtt-intel-mcp': minor
---

A seventh tool, `mqtt_infer_schema`, and the shape of a topic's payloads in `mqtt_describe_topic`.

The shape is inferred from the payloads ingestion was already parsing, so it costs no extra
parse and obeys the same inspection budget. `mqtt_infer_schema` returns a JSON Schema ready to
export; `mqtt_describe_topic` carries the same shape as a flat field list, so one call answers
"what is this topic".

Fields report the share of payloads that carried them rather than the word "optional":
"in 25% of payloads" is a fact about what arrived, "optional" is a claim about intent. The
answer says how many payloads are behind the shape, and `SCHEMA_TRUNCATED` appears in the
limitations when a limit stopped inference inside the payload.

---
'@kadeya/mqtt-intel-core': minor
---

Payload shapes can now be inferred from the payloads themselves, incrementally and mergeably.

`observeJson` folds a JSON value into a schema, `mergeSchemas` combines two, and
`toJsonSchema` exports draft 2020-12. A schema is counts rather than flags — how many values
were seen at a position, and how many of each type — so merging is addition, optionality is
derived from the counts instead of stored, and a union is simply more than one type above
zero.

An object with more than 32 distinct keys becomes a map, because such an object is keyed by
an identifier rather than being a record with a thousand fields, and because that is what
keeps a schema from growing with the traffic. Nesting beyond six levels stops and says so.

Nothing is wired into the catalogue or the tools yet; that is the next step.

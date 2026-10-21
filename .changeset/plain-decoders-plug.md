---
'@kadeya/mqtt-intel-core': minor
'@kadeya/mqtt-intel-mcp': minor
---

Payloads the classifier can only call binary can now be read by a registered decoder.

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

# ADR-0010 — Payload classification and LLM-safe payload views

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

MQTT payloads are arbitrary bytes: JSON, plain values, text, binary encodings (Sparkplug B
protobuf, CBOR, vendor formats), invalid UTF-8, empty messages, or very large blobs.
Anything returned by a tool is sent to a language model: it consumes context, may contain
sensitive data, and may contain adversarial text.

## Decision

- **Classification** is deterministic and ordered: `empty` → `unknown` (oversized, above
  `maxInspectBytes`) → `binary` (invalid UTF-8 or too many control characters) → `boolean`
  (`true`/`false`) → `number` (finite numeric literal) → `json` (parses and starts with
  `{`, `[` or `"`) → `text`. MQTT 5 `contentType` and `payloadFormatIndicator` are recorded
  as facts but never override byte inspection.
- **Payload views** are the only way payload content leaves the core:
  - `json`: depth, key-count, array-length and string-length limits; configured keys
    redacted (count of redacted keys reported);
  - `text`: character limit, control characters escaped, `truncated` flag;
  - `binary`: size, SHA-256 and a hex preview of the first 32 bytes; **never** base64 of
    the full payload;
  - `unknown`: size and reason.
- Classification is part of V0.1 because it is a **safety prerequisite** for returning any
  payload, not an optional "intelligence" feature.
- **Decoder extension point** (public in V0.2): `PayloadDecoder` implementations registered
  for topic filters or content types (e.g. a future `decoder-sparkplug` package) produce a
  decoded JSON-like value that then goes through the same view and redaction rules.

## Consequences

- Positive: no raw binary or unbounded text ever reaches the model; behaviour is
  reproducible and testable with malformed inputs.
- Negative: heuristic edge cases (for example, a text payload that happens to be valid
  JSON) are resolved by a fixed, documented order rather than by guessing intent.

## Alternatives considered

- **Assume JSON, fall back to string:** breaks on binary and leaks unbounded data.
- **Return base64 for binary:** wastes context and is useless to the model.

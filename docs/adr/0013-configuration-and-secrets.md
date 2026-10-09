# ADR-0013 — YAML configuration validated by zod; secrets by reference

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Operators need to describe several brokers, TLS/mTLS material, security rules and limits in a
reviewable, versionable file, without ever committing secrets. Developers also need a
zero-file quick start. Security configuration mistakes must never be silently ignored.

## Decision

- **Format:** YAML (via the `yaml` package, zero dependencies), loaded from `--config` or
  `MQTT_INTELLIGENCE_CONFIG`. A `version: 1` field allows future migrations.
- **Quick start without a file:** `MQTT_URL` (+ optional `MQTT_USERNAME`, `MQTT_PASSWORD`,
  `MQTT_BROKER_ID`) produces a single-broker configuration with defaults.
- **Validation:** one zod v4 schema in `core/config`; the TypeScript type is inferred from
  it. **Unknown keys are errors.** Error messages include the full path and a hint.
- **Secrets by reference:** `SecretRef = { env: NAME } | { file: PATH }` for passwords, key
  passphrases and tokens. Plain-text secret values are rejected by the schema. Usernames may
  be plain strings. File references support Docker and Kubernetes mounted secrets.
- **Credentials in URLs are rejected** (`mqtt://user:pass@host`).
- Secrets are resolved once at start into `Secret` objects whose `toString`, `toJSON` and
  `util.inspect` return `[REDACTED]`; only the mqtt.js adapter calls `reveal()`.
- TLS files are loaded by our code and passed as Buffers; relative paths are resolved from
  the configuration file's directory.
- The resolved configuration is deeply frozen. Hot reload is out of scope.
- `rejectUnauthorized: false` is allowed but logged as a warning and reported as `insecure`
  in `mqtt_list_brokers`.

## Consequences

- Positive: reviewable configuration, no secrets in git, early and precise failures.
- Negative: one runtime dependency (`yaml`); accepted because Node has no YAML parser and
  YAML is the norm for operators.

## Alternatives considered

- **JSON only:** no dependency, but poor for comments and hand editing.
- **Environment variables only:** unmanageable with several brokers and rule lists.
- **`${ENV}` string interpolation everywhere:** makes it easy to interpolate secrets into
  places that get logged; explicit references are safer.

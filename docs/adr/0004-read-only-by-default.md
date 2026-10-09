# ADR-0004 — Read-only by default; one policy engine with deny precedence

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Agents can be manipulated through prompt injection, including through the MQTT payloads and
topic names they read. MQTT publishes can actuate physical equipment. Reading can also be
harmful: payloads may contain personal data, credentials or trade secrets that would be sent
to a third-party model provider.

## Decision

1. **All authorization decisions go through a single `policy` module** in the core. Adapters
   never decide.
2. **Deny always beats allow**, for reading and for publishing.
3. **Read policy** (`security.read.allow/deny`, global and per broker; per-broker deny lists
   are unioned with the global one):
   - a subscription whose filter lies entirely inside a deny rule is rejected
     (`ACCESS_DENIED`);
   - a subscription overlapping a deny rule is allowed, and matching messages are **dropped
     at ingest**: never counted in the catalog, never stored, never listed.
4. **JSON redaction** of configured key names (case-insensitive) in every payload view.
5. **Publishing does not exist in V0.1–V0.3.** When introduced (V0.4, with its own ADR and
   threat review) it must satisfy all of the following:
   - `security.publish.enabled: true` globally **and** per broker; otherwise the tool is
     **not registered** at all, so the agent cannot see it;
   - a non-empty allow-list; allow rules equal to `#`, `+/#` or starting with a wildcard are
     rejected at config validation unless `acknowledgeBroadPublish: true` is set;
   - deny rules evaluated first; payload size limit; QoS ceiling; retain forbidden unless
     `allowRetain: true`; rate limit; an audit log entry for every attempt;
   - tool annotated `destructiveHint: true`; optional confirmation through MCP elicitation.
6. The broker ACL remains the **authoritative** control. Documentation requires a dedicated
   read-only broker account in production. Our policy protects against agent mistakes, not
   against a compromised host.

## Consequences

- Positive: the safest possible default, simple to audit (one module, exhaustive tests).
- Positive: read-side protection (deny + redaction) addresses data exfiltration, which the
  brief did not cover.
- Negative: users who need write access wait for V0.4 and must configure it explicitly.

## Alternatives considered

- **Allow-only lists** (as in some existing servers): one broad rule opens everything.
- **Deny-only lists:** unsafe by default.
- **Publish tool always registered but refusing calls:** exposes the capability to the model
  and invites attempts; not registering it is strictly safer.

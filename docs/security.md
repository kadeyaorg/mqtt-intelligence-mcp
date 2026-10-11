# Security model and threat model

Connecting a language model to an operational MQTT broker deserves more care than connecting a
dashboard to one. This document says what the server defends against, how, and — the part that
matters more — what it does not defend against.

For reporting a vulnerability, see [SECURITY.md](../SECURITY.md).

## The short version

1. **There is no publish path.** Not disabled: absent.
2. **Deny beats allow**, and a denied topic is dropped at ingest.
3. **Payloads and topic names are untrusted data**, treated as data.
4. **Secrets are references**, and print as `[REDACTED]` wherever they are touched.
5. **Everything is bounded**, and whatever is dropped is counted and reported.
6. **Your broker's ACLs remain the authoritative control.** This is a second lock.

## What we are defending against

Four actors, with different capabilities.

### The agent

A language model choosing tool calls. It is not malicious, but it is suggestible, confident,
and able to be talked into things by text it reads.

| It might                                      | What stops it                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Publish to a topic that moves a machine       | No publish tool exists. The configuration key that would enable one is refused by the schema in this version.            |
| Read a topic it should not                    | The read policy, applied at ingest. Denied topics never enter the catalogue, so no tool can return one.                  |
| Ask for a filter that bypasses the policy     | Filters are checked before the broker is asked; a refused one is reported in `coverage.rejectedFilters`.                 |
| Pass a regular expression that never finishes | No tool accepts one. Search is substring and MQTT filter only.                                                           |
| Ask for unbounded output                      | Every limit is clamped server-side by `mcp.maxResultItems` and the per-tool maxima.                                      |
| Conclude a topic does not exist               | Every answer carries its observation window and `SHORT_OBSERVATION_WINDOW`. "Not observed" never means "does not exist". |
| Conclude one event caused another             | The engine produces facts and observations, never inferences. Temporal proximity is reported as proximity.               |

### The devices

Whatever publishes to the broker. It is not under our control, it may be compromised, and it
may be publishing attacker-chosen bytes.

| It might                                                | What stops it                                                                                                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publish a payload that reads as instructions to a model | Payloads are classified, truncated, escaped and redacted; the two tools that show payload content state in their own description that payload content is data and never instructions.                   |
| Publish a topic name that reads as instructions         | Topic names are covered by the same statement and the same escaping.                                                                                                                                    |
| Publish a credential in clear                           | Redaction by key name, before the value leaves the server.                                                                                                                                              |
| Publish a 400 MB payload                                | Payloads above `maxInspectBytes` are never parsed; what is stored is capped by `maxStoredPayloadBytes`; pending bytes are capped by `pendingPayloadMaxBytes` and the excess is dropped **and counted**. |
| Publish a million distinct topics                       | `maxTopicsPerBroker`, with `evict-lru` or `ignore-new`, and an eviction counter in every answer's coverage.                                                                                             |
| Publish faster than we can inspect                      | Ingestion counts every message and inspects a sample: `SAMPLED` appears in the limitations. Counts stay exact.                                                                                          |
| Publish deeply nested or enormous JSON                  | Depth, width and string length are bounded when the value is rebuilt; `TRUNCATED` says so.                                                                                                              |
| Publish invalid UTF-8 or control characters             | Classified as binary and never dumped: a size, a short hex preview, a digest.                                                                                                                           |

### The broker

| It might                                      | What happens                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Refuse a subscription                         | Reported in `coverage.rejectedFilters`, not hidden, and `check` exits non-zero.                                                                  |
| **Accept a subscription and deliver nothing** | **Nothing stops this, and no MQTT client can detect it.** See below.                                                                             |
| Replay retained messages at subscribe time    | Marked `retainedReplay`, with `RETAINED_REPLAY_TIME_UNKNOWN`: the receipt time is when we subscribed.                                            |
| Downgrade QoS                                 | Delivered QoS is reported as delivered, with `DELIVERED_QOS_ONLY`.                                                                               |
| Drop the connection                           | The gap is recorded in `coverage.gaps` with `DISCONNECTED_DURING_WINDOW`; reconnection is full-jitter backoff, and subscriptions are reinstated. |
| Refuse the credentials                        | No retry loop. `BROKER_AUTH_FAILED` says retrying will not help.                                                                                 |

### The host

Whoever can run code where this server runs. **We do not defend against them.** They have the
configuration file, the environment, and the broker account. The mitigation is not in this
software: give that account nothing it does not need.

## What this does not protect you from

Said plainly, because a security model that only lists its strengths is marketing.

**A broker that accepts a subscription and delivers nothing on it.** Mosquitto does exactly
this when an ACL forbids a topic: the SUBACK is a success and no message ever arrives. We
found it while writing the integration tests. `check` therefore reports what the broker
_accepted_, not what it will deliver, and says so.

**Your broker's access control.** If the account can subscribe to a topic, this server's
policy is the only thing between an agent and that topic — and it is software, in the same
process as everything else. A dedicated read-only account restricted at the broker is a
different kind of control, and it is the one that holds if this one fails.

**What your MCP client sends to its model.** We truncate, redact and bound what we return.
What the client then puts in a context window, and where that context window lives, is the
client's decision and your policy.

**A model that ignores what it is told.** Every answer states its limitations in words a model
can read. We cannot make it read them. What we can do — and do — is never state an inference
ourselves, so there is nothing authoritative to misquote.

**Traffic analysis.** Topic names and message rates are visible to anyone who can see the
connection. Use TLS.

## stdout is the protocol

In stdio mode, stdout carries MCP protocol frames and nothing else. A single stray line
corrupts the session. This is enforced three ways: a `Logger` port that writes to stderr, an
ESLint rule banning `process.stdout` in product code with no exception, and a test that spawns
the real binary and asserts every line of its stdout parses as JSON-RPC.

It is why `--help` and `--version` go to stderr too
([ADR-0018](adr/0018-cli-contract.md)).

## Secrets

A secret is a reference in the file (`{ env: … }` or `{ file: … }`) and a `Secret` object in
the process, whose value is revealed only when building the MQTT connection. `toString`,
`toJSON` and Node's inspection all yield `[REDACTED]`, so logging one by accident is not
possible.

Errors are sanitized before they leave the engine: credentials in a URL, `Authorization`
headers and known secret-shaped fields are masked. Unexpected errors return a correlation id
and nothing else, because an unexpected error can quote anything it touched.

## Hardening a deployment

1. A dedicated broker account, read-only, restricted to the topics the agent is meant to see.
2. TLS, with `rejectUnauthorized` left on. `check` prints a warning in capitals if you turn it
   off.
3. `discovery.filters` narrowed, so the traffic never crosses the network.
4. `security.read.allow` narrowed, and `security.read.deny` for anything inside it that should
   not be read.
5. `security.redaction.jsonKeys` extended with your own payload keys — matching is on whole
   key names.
6. Limits reviewed against your namespace: `maxTopicsPerBroker`, `recentMessagesPerTopic`,
   `messageStoreMaxBytes`.
7. `check` run, and its exit code acted on, before an agent is connected.

## Deciding records

- [ADR-0004](adr/0004-read-only-by-default.md) — read-only by default, one policy engine, deny precedence
- [ADR-0009](adr/0009-bounded-ingestion.md) — count everything, inspect a sample, drop and count
- [ADR-0010](adr/0010-payload-classification-and-safe-views.md) — payload classification and safe views
- [ADR-0011](adr/0011-facts-observations-limitations.md) — facts, observations, limitations
- [ADR-0013](adr/0013-configuration-and-secrets.md) — configuration and secrets by reference
- [ADR-0014](adr/0014-typed-errors-with-stable-codes.md) — typed errors, sanitized

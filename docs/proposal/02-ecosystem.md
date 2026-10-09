# 02 — Ecosystem review

> Status: **Approved on 2026-09-18.** Decisions are recorded in the [ADRs](../adr/README.md), which prevail over this document where they differ.
> Research date: **2026-09-18**. Versions were checked against the npm registry, the
> upstream repositories and the specifications. Items marked _(unverified)_ could not be
> confirmed from primary sources.

## 1. MCP TypeScript SDK

### Current state

| Item                 | Finding                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------ |
| Latest spec revision | **2026-07-28** (previous: 2025-11-25)                                                      |
| SDK major            | **v2.0.0**, released 2026-07-27, split into packages                                       |
| Package for a server | **`@modelcontextprotocol/server`** (+ `@modelcontextprotocol/node` only when serving HTTP) |
| Legacy line          | `@modelcontextprotocol/sdk` 1.30.x — security/bug fixes only, not for new projects         |
| Node requirement     | `>=20`                                                                                     |
| Module format        | ESM-first, ships ESM + CJS builds                                                          |
| Validation           | **Zod v4** (direct dependency; Zod v3 unsupported). Any Standard Schema library works.     |

### Spec 2026-07-28 changes that shape our design

- **Stateless protocol.** No `initialize` handshake, no `Mcp-Session-Id`. Any state that
  must survive across calls must be modelled by the server as _explicit handles passed as
  tool arguments_. → Our `captureId` design is exactly the idiomatic pattern.
- **Tasks moved to an extension** (`io.modelcontextprotocol/tasks`) and the SDK v2 does
  **not** implement it. → Long-running captures must use our own handles + progress
  notifications + cancellation (`AbortSignal`), not SDK tasks.
- **Logging (`notifications/message`), sampling and roots are deprecated.** → We log to
  stderr only and never depend on MCP logging. We never use sampling (consistent with
  "no LLM inside the core").
- **Elicitation** becomes a multi-round-trip `input_required` result. → A natural fit for a
  future _publish confirmation_ step (V0.4), not needed before.
- **Tools:** `inputSchema`/`outputSchema` are JSON Schema 2020-12; `structuredContent`
  can be any JSON value and is validated against `outputSchema` by the SDK; invalid inputs
  become `isError: true` results automatically. Annotations `readOnlyHint`,
  `destructiveHint`, `idempotentHint` (and `openWorldHint` from earlier revisions) remain.
- **Resource subscriptions** replaced by a single `subscriptions/listen` stream. → We do
  not build on resource subscriptions in V0.x.

### Server API we will use

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

server.registerTool(
  'mqtt_list_brokers',
  {
    title: 'List MQTT brokers',
    description: '…',
    inputSchema: z.object({/* … */}),
    outputSchema: z.object({/* … */}),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args, ctx) => {
    // ctx.mcpReq.signal        -> AbortSignal (cancellation)
    // ctx.mcpReq._meta?.progressToken + ctx.mcpReq.notify(...) -> progress
    return { content: [{ type: 'text', text }], structuredContent: out };
  },
);
```

### Things to avoid

- v1 APIs (`server.tool()`, deep `.js` imports, raw-shape schemas), `SSEServerTransport`,
  `McpError` (now `ProtocolError`), MCP logging/sampling/roots, anything session-based.
- Host support for the 2026-07-28 revision is still rolling out _(unverified per host)_; the
  SDK's `serveStdio` also serves 2025-era clients by default, which covers us.

## 2. mqtt.js

| Item          | Finding                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latest        | **5.16.0** (2026-09-16) — **fixes 6 security advisories** (a malicious broker can crash clients ≤ 5.15.2; no v4 backport). **Minimum: `mqtt@^5.16.0`.** |
| Health        | Active (last push 2026-09-16), ~21 open issues, a v6 rewrite with fewer dependencies is planned.                                                        |
| Types         | Bundled, including typed events.                                                                                                                        |
| Module format | **CJS in Node** (ESM build is browser-only). Consumed from ESM via Node's CJS interop.                                                                  |
| Dependencies  | `ws`, `mqtt-packet`, `worker-timers`, `lru-cache`, `socks`                                                                                              |
| MQTT 5        | Full: properties, user properties, subscription options (`nl`, `rap`, `rh`), subscription identifiers, reason codes.                                    |

### Behaviours that directly influence our design

1. **`subscribeAsync` rejects the whole call if any filter fails** (SUBACK ≥ 0x80), and
   failed filters are removed from mqtt.js's resubscribe set. → We subscribe **one filter
   per call** and own resubscription ourselves (`resubscribe: false`).
2. **`connectAsync` can wait through retries indefinitely** for some stream errors
   _(from code reading, unverified by test)_. → Our connection controller applies its own
   hard timeout and uses `reconnectPeriod: 0` with its own backoff.
3. **Backpressure:** overriding `handleMessage(packet, cb)` delays PUBACK and pauses socket
   reads, but it **also delays PINGRESP processing**, causing keepalive timeouts and
   reconnect loops (open issues #1935, #2026). → We never hold the handler: messages are
   accepted synchronously into a **bounded queue with drop-and-count**.
4. **Retain flag:** RETAIN=1 on delivery means _retained replay at subscribe time_; live
   messages carry RETAIN=0 unless subscribed with `rap: true` (MQTT 5).
5. **`#` never matches `$`-prefixed topics**; `$SYS/#` must be subscribed explicitly.
6. **Ordering** is guaranteed only per topic, per QoS, per publisher; in mqtt.js QoS 2
   messages surface on PUBREL and can overtake QoS 0/1 → our timeline documents ordering
   by _receipt_, never "publish order".
7. **Topics named `__proto__` / `resubscribe`** are lost on mqtt.js reconnect (open PR
   #2058). → All our per-topic structures use `Map`, never plain objects; our own
   resubscription avoids the bug.
8. **TLS:** `ca`, `cert`, `key`, `servername`, `ALPNProtocols`, `rejectUnauthorized`
   (default true). `keyPath`/`certPath`/`caPaths` exist in types but are **not read** → we
   load files ourselves and pass Buffers. AWS IoT on 443 needs ALPN `x-amzn-mqtt-ca`.
9. **`unsubscribeAsync` never rejects on reason codes** → we check UNSUBACK codes.

## 3. Node.js LTS (as of 2026-09-18)

| Line | Status                             |
| ---- | ---------------------------------- |
| 20   | **End of life** (2026-04-30)       |
| 22   | Maintenance LTS until 2027-04-30   |
| 24   | Active LTS                         |
| 26   | Current, becomes LTS on 2026-10-28 |

→ `engines.node: "^22.12.0 || >=24.0.0"`; blocking CI on the LTS lines 22 and 24; Node 26 as an experimental, non-blocking job until it enters LTS (ADR-0001).

## 4. Existing MQTT-related MCP projects

### 4.1 MCP servers that let an agent use MQTT

| Project                    | Lang / License     | Notable capabilities                                                                                      | Gap vs. our goals                                |
| -------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| ezhuk/mqtt-mcp             | Python, MIT        | receive/publish, topics as resource templates, OAuth                                                      | No discovery, schema, guard                      |
| benniu/emqx-mcp-server     | Python, Apache-2.0 | EMQX REST admin (clients, publish)                                                                        | Vendor-specific                                  |
| tspspi/mcpMQTT             | Python, BSD-3      | publish/subscribe with **per-pattern read/write ACL**                                                     | Allow-only, no deny precedence                   |
| Schimmilab/mqtt-mcp-server | Python, MIT        | SQLite history, topic list/tree, silent topics, gaps, cross-broker overlap                                | Very small, blocklist "not a security boundary"  |
| eduard256/mqtt-mcp-server  | Python             | discovery scan, record up to 300 s                                                                        | Basic                                            |
| AddisonTech/Iris           | Python, MIT        | read-only list/latest                                                                                     | Early scaffold                                   |
| nagarjunr/iot-mcp-servers  | Python, MIT        | MQTT 5, Sparkplug B, AWS IoT, Azure IoT servers                                                           | Tool details _(unverified)_                      |
| industrial-aiops           | Python, MIT        | 14 OT protocols; Sparkplug schema, UNS audit, schema drift, audit log, risk tiers, MOC approval on writes | Python, OT-platform scope, not MQTT-generic      |
| slalaure/korelate          | JS, Apache-2.0     | Full UNS app: DuckDB history, schema inference, Sparkplug decode, `/mcp` endpoint                         | An application, not a lightweight server/library |
| Litmus MCP Server          | Python, MIT        | Litmus Edge topics/history                                                                                | Vendor-specific                                  |
| HighByte Intelligence Hub  | Commercial         | Read-only discovery tools ("not meant for production")                                                    | Commercial, embedded                             |
| Coreflux MQTT MCP          | Python, Apache-2.0 | publish, broker info                                                                                      | Vendor-specific                                  |

Plus many small publish/subscribe wrappers (`mcp2mqtt`, `mqttx-mcp-sse-server`,
`@brightlightrx/mqtt-mcp`, `midhunxavier/MQTT-MCP` with Sparkplug births, …).

### 4.2 "MCP over MQTT" — a different category

EMQX's `mqtt-ai/mcp-over-mqtt` specification and SDKs (`emqx/mcp-typescript-sdk`, ESP32,
Paho) use **MQTT as the transport of MCP itself**, so that MCP servers can run on devices.
They do not give an agent insight into an MQTT namespace. **Not a competitor**; a possible
optional transport for us much later.

### 4.3 Vendors

No public MQTT MCP server from HiveMQ, Cedalo/Mosquitto or AWS (IoT Core) was found.
AWS ships an IoT SiteWise MCP server (different scope).

## 5. What is already covered — and what actually differentiates us

**Commodity (do not compete on it):** connect/publish/subscribe wrappers, time-boxed
record, last-value caches, vendor admin APIs, basic allow-lists.

**Our differentiation — the combination nobody ships today:**

1. **A library-grade engine in TypeScript**, installable with `npx`, usable without MCP.
2. **Bounded, observable discovery catalog** (count everything, inspect a sample, bounded
   memory, visible drop counters, observation coverage and gaps).
3. **Payload classification + safe rendering** for LLMs (never naive binary, never
   unbounded text).
4. **Schema inference with evolution and change detection** (V0.2/V0.3).
5. **FACT / OBSERVATION / LIMITATION-labelled outputs** — the anti-hallucination contract.
6. **Security policy with deny precedence**, read-side deny + redaction, and publish that
   is not even registered as a tool unless enabled.
7. **Multi-broker as a first-class dimension.**
8. **Observability of the server itself** (metrics, structured logs, OTel-aligned).

**Projects worth studying before implementation:** Schimmilab (history, silence and gap
detection, multi-broker overlap), industrial-aiops (governance model, schema drift,
Sparkplug), mcpMQTT (ACL ergonomics).

**Consequences for scope:** because commodity pub/sub wrappers already exist, V0.1 must
already demonstrate the differentiation (catalog + safe payloads + coverage caveats),
not ship "yet another subscribe tool".

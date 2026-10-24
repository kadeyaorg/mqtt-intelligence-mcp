# @kadeya/mqtt-intelligence-core

The engine behind [MQTT Intelligence MCP](https://github.com/kadeyaorg/mqtt-intelligence-mcp),
as a library. **No MCP dependency**: this is the part that connects to brokers, watches a
namespace and answers questions about it, and it can back a CLI, a service or your own program
just as well as it backs an MCP server.

```ts
import { createEngine, loadConfig } from '@kadeya/mqtt-intelligence-core';

const engine = createEngine(await loadConfig({ path: './mqtt-intelligence.yaml' }));
await engine.start();

const answer = await engine.discover({}, { onProgress: (p) => console.error(p.message) });
console.error(answer.facts.topicCount, answer.limitations);

await engine.close();
```

## What it gives you

- **Multi-broker** connections: MQTT 3.1.1 and 5, TLS, mutual TLS, WebSockets, each with its
  own credentials, policy and reconnection.
- **Passive discovery** with a bounded topic catalogue and per-topic statistics.
- **Safe payload views**: JSON, text, number, boolean and binary, classified, truncated,
  escaped and redacted. Binary is never dumped.
- **A read policy** where deny beats allow, applied at ingest: a denied topic is never stored,
  counted or listed.
- **Answers with their own limits**: every answer carries what was observed, what was computed
  and by which method, what the engine could see, and what it cannot tell you.

It never produces an inference. It will tell you two events were 1.2 seconds apart; it will not
tell you one caused the other.

## Ports

MQTT access, storage, time, logs and metrics all sit behind ports, each with a fake beside it.
`@kadeya/mqtt-intelligence-core/testing` ships `FakeClock`, `FakeTransport`, a recording logger, an
in-memory metrics recorder, and the **contract test suites** a storage adapter must pass.

```ts
import { FakeClock, FakeTransportFactory } from '@kadeya/mqtt-intelligence-core/testing';

const engine = createEngine(config, {
  clock: new FakeClock(),
  transportFactory: new FakeTransportFactory(),
});
```

## Documentation

**[github.com/kadeyaorg/mqtt-intelligence-mcp](https://github.com/kadeyaorg/mqtt-intelligence-mcp)**
— configuration reference, security model, architecture and decision records.

The MCP server built on this is
[`@kadeya/mqtt-intelligence-mcp`](https://www.npmjs.com/package/@kadeya/mqtt-intelligence-mcp).

Apache-2.0 · Node.js 22 (≥ 22.12), 24 or 26

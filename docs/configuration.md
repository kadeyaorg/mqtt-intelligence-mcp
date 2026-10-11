# Configuration

One YAML file, validated before anything connects. A mistake in it is an exit code 3 and a
message naming the field, never a silently different behaviour
([ADR-0013](adr/0013-configuration-and-secrets.md)).

JSON is valid YAML, so a `.json` file works equally well.

## Where it comes from

In order:

1. `--config <file>` on the command line;
2. the `MQTT_INTELLIGENCE_CONFIG` environment variable;
3. the file-less quick start: `MQTT_URL`, plus optional `MQTT_BROKER_ID`, `MQTT_USERNAME`,
   `MQTT_PASSWORD`.

The quick start produces exactly the document a file would, so there is one code path
afterwards. It gives one broker with default settings — which means it may read everything.
Right for a first run on a laptop, wrong for anything else.

**Relative paths inside the file resolve against the file**, not the working directory, so a
configuration directory with its `certs/` beside it can be moved or mounted as a whole.

## Secrets

A secret is never written in the file. It is referenced:

```yaml
password:
  env: MQTT_PASSWORD
# or
password:
  file: /run/secrets/mqtt-password
```

A password written as a string is **refused by the schema**, with an error that says what to
write instead. That is what lets these files be committed.

Inside the process a secret is a `Secret` object whose value is revealed only when building
the MQTT connection. Printing it, serializing it or logging it yields `[REDACTED]` —
including by accident, which is the point.

## The whole file

Everything except `version` and `brokers` has a default.

```yaml
version: 1 # required, and the only accepted value

brokers: # required, at least one
  factory-fr: # the id: 1–63 chars, lowercase letters, digits, - or _
    url: mqtts://broker.example.com:8883 # required; mqtt, mqtts, ws or wss
    protocolVersion: 5 # 5 = MQTT 5, 4 = MQTT 3.1.1
    connect: startup # or "lazy": connect on first use
    clientId:
      prefix: mqtt-intel # a random suffix is added (default)
      # fixed: my-reader             # opt-in: reusing an id disconnects whoever holds it
    auth:
      username: mcp-reader # not a secret; may be inline
      password: { env: MQTT_PASSWORD } # a reference, always
    tls:
      ca: { file: ./certs/ca.crt }
      cert: { file: ./certs/client.crt } # mutual TLS: cert and key, both or neither
      key: { file: ./certs/client.key }
      keyPassphrase: { env: KEY_PASSPHRASE }
      serverName: broker.example.com # when the address is not the certificate's name
      alpn: [] # e.g. ["x-amzn-mqtt-ca"] on AWS IoT over 443
      rejectUnauthorized: true # leave it on
    timeouts:
      connectMs: 10000 # 1000 – 120000
      keepaliveSeconds: 30 # 5 – 3600
    reconnect:
      initialDelayMs: 1000 # 100 – 60000, full jitter from here
      maxDelayMs: 60000 # 1000 – 3600000
    discovery:
      enabled: true
      filters: ['#'] # what to subscribe to. Narrow this
      includeSysTopics: false # "#" never matches $SYS; ask for it by name
      subscriptionQos: 0 # 0, 1 or 2
    security:
      read:
        allow: ['#'] # per-broker; replaces the global allow
        deny: [] # per-broker; added to the global deny

security:
  read:
    allow: ['#'] # global default for brokers that set none
    deny: [] # global; a broker cannot undo these
  redaction:
    jsonKeys: [password, token, secret, apikey, …] # see below
  publish:
    enabled: false # the only accepted value in this version

limits:
  maxTopicsPerBroker: 50000 # 1 – 5000000
  onTopicLimit: evict-lru # or "ignore-new"
  maxInspectBytes: 262144 # larger payloads are never parsed
  maxStoredPayloadBytes: 8192 # must not exceed maxInspectBytes
  recentMessagesPerTopic: 20 # 1 – 1000
  messageStoreMaxBytes: 134217728 # 1 MiB – 4 GiB
  pendingPayloadMaxBytes: 67108864 # payload bytes awaiting inspection
  flushIntervalMs: 100 # 10 – 5000
  inspectionsPerFlush: 2000 # 1 – 100000

mcp:
  maxResultItems: 200 # 1 – 1000; clamps every tool's limit
  maxPayloadPreviewChars: 2000
  discoverMaxWaitSeconds: 30 # 1 – 300; clamps waitSeconds

storage:
  type: memory # the only option in this version

logging:
  level: info # trace | debug | info | warn | error
  format: json # or "pretty" for a terminal
```

## The parts that matter most

### `discovery.filters` and `security.read.allow` are different things

`discovery.filters` is what the server **asks the broker for**. `security.read.allow` is what
it will **keep**. Narrowing the first means the traffic never crosses the network; narrowing
the second means it never reaches the catalogue. Do both.

Overlapping filters cost nothing: the server computes a minimal covering set, so subscribing
to `factory/#` and `factory/line-01/#` sends one subscription, not two. Without that, a broker
delivers the same message twice.

`#` never matches a topic beginning with `$`, so `$SYS` must be asked for by name:
`includeSysTopics: true`.

### Deny beats allow, everywhere

A global deny cannot be undone by a broker's own rules. A denied topic is dropped **at
ingest**: never stored, never counted, never listed, never returned. There is no argument an
agent can pass to get around it ([ADR-0004](adr/0004-read-only-by-default.md)).

A broker's `security.read.allow` replaces the global allow for that broker; its `deny` is added
to the global one.

### Redaction matches whole key names

Lowercased, and whole: `apikey` does **not** catch `maintenanceApiKey`. Setting
`security.redaction.jsonKeys` **replaces** the defaults rather than adding to them, so repeat
the ones you still want. The defaults are `password`, `passwd`, `pwd`, `secret`, `token`,
`apikey`, `api_key`, `authorization`, `credential`, `credentials`, `privatekey`,
`private_key`, `passphrase`.

### `clientId` disconnects things

An MQTT broker disconnects the older session when a client id is reused — on a plant network,
that means disconnecting a device. So `prefix` with a random suffix is the default, and `fixed`
is opt-in, for the brokers that treat the client id as an identity (Azure Event Grid) rather
than a connection detail.

### `connect: lazy`

A broker nobody asks about most days need not be connected at all until someone does. A broker
that is down then produces no connection noise until it is needed. `check` tests every broker
regardless, which is the point of `check`.

## Checking it

```bash
mqtt-intel-mcp check --config ./mqtt-intelligence.yaml
```

Validates the file, connects every broker, subscribes the discovery filters, and reports all of
them before exiting. Exit code 3 means the file is wrong and says which field; exit code 4
means the file is fine and a broker is not. Nothing connects before the file validates.

`check` reports what the broker **accepted**. A broker may accept a subscription and then
deliver nothing on it — no MQTT client can detect that — so its ACLs remain the authoritative
control.

## Examples

[`examples/configs`](../examples/configs/README.md): one broker, several brokers, TLS and
mutual TLS, AWS IoT Core, Azure Event Grid. Each one is parsed by the real schema in the test
suite, so none of them can rot.

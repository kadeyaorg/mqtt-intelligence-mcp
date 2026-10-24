# Configuration examples

Five starting points. Each is a complete, valid file: `check --config <file>` will tell you
whether the parts you changed work.

| File                                           | For                                                       |
| ---------------------------------------------- | --------------------------------------------------------- |
| [single-broker.yaml](single-broker.yaml)       | One broker, with the read policy to start from            |
| [multi-broker.yaml](multi-broker.yaml)         | Several brokers, each with its own credentials and policy |
| [tls-mutual.yaml](tls-mutual.yaml)             | TLS and mutual TLS, private CA, encrypted key             |
| [aws-iot-core.yaml](aws-iot-core.yaml)         | AWS IoT Core: certificate authentication, ATS endpoint    |
| [azure-event-grid.yaml](azure-event-grid.yaml) | Azure Event Grid: MQTT 5, registered client id            |

A sixth, [../industrial-machine/mqtt-intelligence.yaml](../industrial-machine/mqtt-intelligence.yaml),
configures the local example stack and is the one to copy for a first run.

## What is worth knowing before you edit one

**Secrets are referenced, never written.** `password: { env: MQTT_PASSWORD }` or
`{ file: /run/secrets/mqtt }`. A password written as a string is refused by the schema, with
an error that says what to write instead — so these files can be committed.

**Relative paths resolve against the file, not the working directory.** A configuration
directory with its `certs/` beside it can be moved, mounted or shipped as a whole.

**The default read policy is `#`.** It is the right default for a first run on a laptop and
the wrong one for anything else. Narrowing `security.read.allow`, and narrowing
`discovery.filters` so the broker is never even asked, are two different things worth doing
together.

**Deny beats allow, everywhere.** A global deny cannot be undone by a broker's own rules, and
a denied topic is dropped at ingest: never stored, never counted, never listed. There is no
argument an agent can pass to get around it.

**Your broker's ACLs remain the authoritative control.** This file is a second lock. A broker
may accept a subscription it never delivers on, which no client can detect, so give the MCP
server an account that cannot read what it should not.

**Redaction matches whole key names, lowercased.** `apikey` does not catch
`maintenanceApiKey`. Listing `security.redaction.jsonKeys` replaces the defaults rather than
adding to them, so repeat the ones you still want.

## Checking one

```bash
npx @kadeya/mqtt-intelligence-mcp check --config examples/configs/single-broker.yaml
```

Exit code 3 means the file is wrong and says which field. Exit code 4 means the file is fine
and a broker is not. Nothing is connected before the file validates.

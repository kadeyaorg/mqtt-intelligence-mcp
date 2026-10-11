# A production line that does not exist

A broker and a fictional factory, so there is something real to ask questions about before
you point the server at a plant.

```bash
docker compose -f examples/industrial-machine/docker-compose.yml up -d --wait
node packages/mcp-server/dist/cli/bin.js check --config examples/industrial-machine/mqtt-intelligence.yaml
```

(`npm install && npm run build` first; once the package is published this becomes
`npx @kadeya/mqtt-intel-mcp check --config …`.)

`check` should print `connection: ok` and `subscribed to factory/#`, and exit 0. Then wire an
MCP client to the same configuration file — see [../mcp-clients](../mcp-clients/README.md) —
and ask it what is out there.

Stop it with `docker compose -f examples/industrial-machine/docker-compose.yml down`. Nothing
is persisted.

## What is published

The line is `factory/line-01`, with a PLC, a robot, a washer, an HMI and a camera.

| Topic                                    | Kind   | Rate                    | Retained |
| ---------------------------------------- | ------ | ----------------------- | -------- |
| `factory/site/metadata`                  | JSON   | once                    | yes      |
| `factory/line-01/plc/state`              | text   | on change               | yes      |
| `factory/line-01/plc/heartbeat`          | number | 1 s                     | no       |
| `factory/line-01/robot/status`           | JSON   | 2 s                     | no       |
| `factory/line-01/robot/position`         | JSON   | 0.5 s                   | no       |
| `factory/line-01/robot/error`            | JSON   | only during an incident | no       |
| `factory/line-01/washer/status`          | JSON   | 3 s                     | no       |
| `factory/line-01/washer/flow-rate`       | number | 1 s                     | no       |
| `factory/line-01/hmi/alarm`              | JSON   | on change               | yes      |
| `factory/line-01/camera/frame`           | binary | 5 s                     | no       |
| `factory/line-01/plc/credentials/rotate` | JSON   | 5 s                     | no       |

Four payload kinds, three retained topics, one topic that only ever speaks during a failure,
and one the server is configured to refuse.

## Four things to try

**Ask what is out there.** `mqtt_discover_topics` then `mqtt_topic_tree`. Notice that the
answer says how long it has been observing and that the window is short: a topic that
publishes once an hour is not in a thirty-second picture, and the limitations say so rather
than letting the model conclude it does not exist.

**Look for the denied topic.** The simulator publishes
`factory/line-01/plc/credentials/rotate` every five seconds. Search for `credentials`, open
the tree, count the topics: it is in none of them. The configuration denies it, so it is
dropped at ingest — never stored, never counted, never listed. Deny beats allow, and there is
no argument an agent can pass to get around it.

**Look at the retained metadata.** `mqtt_get_recent_messages` on `factory/site/metadata`
shows `"maintenanceApiKey": "[REDACTED]"`. The value never leaves the server. The same answer
also marks the message as a retained replay: the broker handed it over at subscribe time, so
its receipt time says when we connected, not when it was published. The server will not let
that pass as a timestamp.

**Wait for the incident.** Every three minutes by default, the robot publishes error 42,
the PLC goes to `FAULT`, the HMI alarm turns on, and the washer stops — 1.2 seconds later.
Ask what happened. A good answer lists both events with their receipt times and says they
were 1.2 seconds apart. It does not say the robot stopped the washer, because nothing the
server can see says so. That separation is the point of the whole project.

To see it sooner:

```bash
SIMULATOR_INCIDENT_INTERVAL_SECONDS=45 docker compose -f examples/industrial-machine/docker-compose.yml up -d --force-recreate simulator
```

## Settings

| Variable                              | Default    | What it does                       |
| ------------------------------------- | ---------- | ---------------------------------- |
| `SIMULATOR_INCIDENT_INTERVAL_SECONDS` | `180`      | Seconds between two incidents      |
| `SIMULATOR_INCIDENT_DURATION_SECONDS` | `25`       | How long the line stays down       |
| `SIMULATOR_SEED`                      | `20260101` | Same seed, same numbers, every run |

## This broker is not a production broker

It allows anonymous connections and speaks plain MQTT on 1883, which is right for a container
you throw away and wrong for everything else. In production, give the MCP server its own
account with read access to the topics it is meant to see, over TLS, and keep the broker's
ACLs as the authoritative control — this server's read policy is a second lock, not the first.
[../configs](../configs/README.md) has configurations that do all three.

## If 1883 is taken

Port 1883 is published on the host because the MCP server runs on the host, next to your MCP
client. Plenty of machines already run a broker there, and the symptom is misleading: the
server connects, subscribes and reports **nothing**, because it connected to the wrong
broker. Move the host side and the URL together:

```bash
MQTT_EXAMPLE_HOST_PORT=18883 docker compose -f examples/industrial-machine/docker-compose.yml up -d --wait
```

then change `url:` in `mqtt-intelligence.yaml` to `mqtt://localhost:18883`. Both, or neither.

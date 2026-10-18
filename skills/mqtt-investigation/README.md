# mqtt-investigation

A skill that teaches an agent **how** to use this server's six tools, as opposed to what they
do. The tool descriptions explain each call; this explains the order to make them in, how to
read the limitations, when the server is the wrong instrument, and the traps that have cost
real time against real machines.

It also bundles the capture script those investigations kept needing.

## Installing it

Copy the directory to wherever your client keeps skills. For Claude Code:

```bash
# Available in every project
cp -r skills/mqtt-investigation ~/.claude/skills/

# Or just this project
cp -r skills/mqtt-investigation .claude/skills/
```

Other clients differ; the layout — a directory containing `SKILL.md` — is the same.

The skill assumes the MQTT Intelligence MCP server is connected. Without it the method still
reads sensibly, but the tools it refers to will not be there.

## The capture script

`scripts/capture.mjs` answers the two questions the server deliberately cannot, because it
samples its stored history so a firehose cannot exhaust it.

```bash
# Publication order within a cycle. Groups arrivals into bursts and flags any topic
# published more than once per burst.
node scripts/capture.mjs timeline mqtt://host:1883 'plc/#' 10

# One topic at full fidelity: intervals, payload digests, MQTT 5 properties — and whether a
# repeated publication comes from one sweep or from two publishers with their own clocks.
node scripts/capture.mjs gaps mqtt://host:1883 plc/state 60
```

It subscribes read-only and never publishes, exactly like the server. It needs the `mqtt`
package on the module path — running it from this repository, or from the server's own
installation, is enough.

Real output, from the machine that prompted all of this:

```
173 arrival(s) on plc/# over 10s, 7 burst(s) at a 221ms threshold

burst at +1561ms — 22 message(s) over 1151ms, repeated: plc/state×2
    +   0ms  plc/screen_resolution
    +  64ms  plc/state
    + 151ms  plc/version
    + 220ms  plc/state
    + 283ms  plc/safety
    …
```

```
plc/state — 81 arrival(s) over 60s (1.35/s)
  distinct payloads: 1 · distinct property sets: 1

  TWO clusters — published more than once per cycle.
    short: 40 gap(s), p50 150ms (91–223)
    long:  40 gap(s), p50 1350ms (1067–1412)
    cycle: about 1500ms
    offset early p50 149ms → late p50 149ms (moved 0ms over 60s)
    The offset is stable: one clock, so one sweep publishing the topic twice.
```

Twenty-one topics, twenty-two publications, and the answer to _why_ in the last line. That
investigation originally took a day of hand-written scripts; the point of bundling it is that
nobody repeats that.

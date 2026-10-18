#!/usr/bin/env node
/**
 * Raw MQTT capture, for the questions the MCP server deliberately cannot answer.
 *
 * The server samples its stored history so that a firehose cannot exhaust it, which makes it
 * the wrong instrument below the flush interval. This subscribes directly and keeps every
 * packet, at the cost of keeping nothing afterwards.
 *
 *   node capture.mjs timeline mqtt://host:1883 'plc/#' 12
 *   node capture.mjs gaps     mqtt://host:1883 plc/state 240
 *
 * Read-only: it subscribes and never publishes. Needs the `mqtt` package — run it from a
 * directory where that resolves (the server's own installation has it).
 */
import { createHash } from 'node:crypto';
import mqtt from 'mqtt';

/** A gap longer than this starts a new burst in the timeline view. */
const BURST_GAP_MS = 400;
/** Bursts to print: enough to see the pattern repeat, few enough to read. */
const BURSTS_SHOWN = 4;

/**
 * @param {number[]} values
 * @returns {{ min: number, p50: number, max: number }}
 */
function summarise(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * Splits values at their widest natural break, which separates two clusters when there are
 * two. A topic published once per cycle has one cluster; one published in pairs has two.
 *
 * @param {number[]} values
 * @returns {{ low: number[], high: number[], separation: number }}
 */
function splitAtWidestGap(values) {
  const sorted = [...values].sort((a, b) => a - b);
  let cut = 0;
  let separation = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const step = (sorted[i] ?? 0) - (sorted[i - 1] ?? 0);
    if (step > separation) {
      separation = step;
      cut = i;
    }
  }
  return { low: sorted.slice(0, cut), high: sorted.slice(cut), separation };
}

/**
 * @param {string} url
 * @param {(client: import('mqtt').MqttClient) => Promise<void>} subscribe
 * @param {(topic: string, payload: Buffer, packet: import('mqtt').IPublishPacket) => void} onMessage
 * @param {number} seconds
 */
async function observe(url, subscribe, onMessage, seconds) {
  const client = await mqtt.connectAsync(url, { protocolVersion: 5, reconnectPeriod: 0 });
  client.on('message', (topic, payload, packet) => {
    onMessage(topic, payload, packet);
  });
  await subscribe(client);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  await client.endAsync();
}

/**
 * Every arrival under a filter, grouped into bursts.
 *
 * A machine usually publishes its topics in one ordered sweep per cycle. Seeing that order is
 * what places an unexpected extra publication: inside the sweep, or on its own.
 *
 * @param {string} url
 * @param {string} filter
 * @param {number} seconds
 */
async function timeline(url, filter, seconds) {
  /** @type {{ at: number, topic: string }[]} */
  const events = [];
  const start = Date.now();
  await observe(
    url,
    // Retain As Published off, so the retain flag means "replayed at subscribe time".
    async (client) => {
      await client.subscribeAsync(filter, { qos: 0, rap: false });
    },
    (topic) => {
      events.push({ at: Date.now() - start, topic });
    },
    seconds,
  );

  // The quiet between two sweeps is whatever this machine leaves, not a number we can guess:
  // a sweep taking 1100 ms of a 1500 ms cycle leaves under 400 ms of silence. So find the
  // natural break in the gaps and cut there, falling back to a fixed threshold when the
  // traffic is too uniform to have one.
  const spacing = events.slice(1).map((event, i) => event.at - (events[i]?.at ?? 0));
  const { low, high, separation } = splitAtWidestGap(spacing);
  const threshold =
    low.length >= 3 && high.length >= 1 && separation > 50
      ? ((low[low.length - 1] ?? 0) + (high[0] ?? 0)) / 2
      : BURST_GAP_MS;

  /** @type {{ at: number, topic: string }[][]} */
  const bursts = [];
  for (const event of events) {
    const current = bursts[bursts.length - 1];
    const last = current?.[current.length - 1];
    if (last === undefined || event.at - last.at > threshold) bursts.push([event]);
    else current?.push(event);
  }

  console.log(
    `${String(events.length)} arrival(s) on ${filter} over ${String(seconds)}s, ` +
      `${String(bursts.length)} burst(s) at a ${String(Math.round(threshold))}ms threshold\n`,
  );
  if (bursts.length === 1) {
    console.log('Publishing is continuous: no silence wide enough to separate cycles.\n');
  }

  // The first burst holds the retained replay, which is not a publication, so skip it when
  // there are others to show.
  const shown = bursts.length > 1 ? bursts.slice(1, 1 + BURSTS_SHOWN) : bursts;
  for (const burst of shown) {
    const first = burst[0];
    const last = burst[burst.length - 1];
    if (first === undefined || last === undefined) continue;
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const event of burst) counts.set(event.topic, (counts.get(event.topic) ?? 0) + 1);
    const repeated = [...counts.entries()].filter(([, n]) => n > 1);

    console.log(
      `burst at +${String(first.at)}ms — ${String(burst.length)} message(s) over ${String(last.at - first.at)}ms` +
        (repeated.length > 0
          ? `, repeated: ${repeated.map(([t, n]) => `${t}×${String(n)}`).join(', ')}`
          : ''),
    );
    for (const event of burst) {
      console.log(`    +${String(event.at - first.at).padStart(4)}ms  ${event.topic}`);
    }
    console.log();
  }
}

/**
 * One topic, at full fidelity: intervals, payload digests, properties, and drift.
 *
 * The drift series is the part that distinguishes one publisher calling publish twice from
 * two publishers with their own clocks. Two clocks never match exactly, so their offset walks
 * through the whole period; one clock holds the offset in a band.
 *
 * @param {string} url
 * @param {string} topic
 * @param {number} seconds
 */
async function gaps(url, topic, seconds) {
  /** @type {{ at: number, size: number, hash: string, retain: boolean, dup: boolean, properties: string }[]} */
  const arrivals = [];
  const start = Date.now();
  await observe(
    url,
    async (client) => {
      await client.subscribeAsync(topic, { qos: 0, rap: false });
    },
    (_topic, payload, packet) => {
      arrivals.push({
        at: Date.now() - start,
        size: payload.length,
        hash: createHash('sha256').update(payload).digest('hex').slice(0, 12),
        retain: packet.retain,
        dup: packet.dup,
        properties: JSON.stringify(packet.properties ?? null),
      });
    },
    seconds,
  );

  if (arrivals.length < 2) {
    console.log(
      `${String(arrivals.length)} arrival(s) on ${topic} over ${String(seconds)}s — not enough to measure.`,
    );
    return;
  }

  const intervals = arrivals.slice(1).map((a, i) => a.at - (arrivals[i]?.at ?? 0));
  const digests = new Set(arrivals.map((a) => a.hash));
  const propertySets = new Set(arrivals.map((a) => a.properties));
  const replays = arrivals.filter((a) => a.retain).length;

  console.log(
    `${topic} — ${String(arrivals.length)} arrival(s) over ${String(seconds)}s (${(arrivals.length / seconds).toFixed(2)}/s)`,
  );
  console.log(
    `  distinct payloads: ${String(digests.size)} · distinct property sets: ${String(propertySets.size)}`,
  );
  console.log(
    `  retained-flagged: ${String(replays)} · duplicate flag set: ${String(arrivals.filter((a) => a.dup).length)}`,
  );
  console.log(`  properties: ${[...propertySets].slice(0, 2).join(' | ')}`);

  const whole = summarise(intervals);
  console.log(
    `  intervals ms: min ${String(whole.min)} · p50 ${String(whole.p50)} · max ${String(whole.max)}`,
  );

  const { low, high, separation } = splitAtWidestGap(intervals);
  // Two clusters are only meaningful when the break is wide and both sides are populated.
  const bimodal = low.length >= 3 && high.length >= 3 && separation > (high[0] ?? 0) / 3;
  if (!bimodal) {
    console.log('\n  One cluster: published once per cycle.');
    return;
  }

  const lowStats = summarise(low);
  const highStats = summarise(high);
  console.log(
    `\n  TWO clusters — published more than once per cycle.\n` +
      `    short: ${String(low.length)} gap(s), p50 ${String(lowStats.p50)}ms (${String(lowStats.min)}–${String(lowStats.max)})\n` +
      `    long:  ${String(high.length)} gap(s), p50 ${String(highStats.p50)}ms (${String(highStats.min)}–${String(highStats.max)})\n` +
      `    cycle: about ${String(lowStats.p50 + highStats.p50)}ms`,
  );

  // Drift: compare the short gap early in the capture with late in it.
  const shortInOrder = intervals.filter((gap) => low.includes(gap));
  const third = Math.floor(shortInOrder.length / 3);
  if (third >= 3) {
    const early = summarise(shortInOrder.slice(0, third));
    const late = summarise(shortInOrder.slice(-third));
    const movement = Math.abs(late.p50 - early.p50);
    console.log(
      `    offset early p50 ${String(early.p50)}ms → late p50 ${String(late.p50)}ms (moved ${String(movement)}ms over ${String(seconds)}s)`,
    );
    console.log(
      movement > (lowStats.p50 + highStats.p50) / 10
        ? '    The offset is drifting: suspect two publishers with independent clocks.'
        : '    The offset is stable: one clock, so one sweep publishing the topic twice.',
    );
  }
  console.log(`\n  short gaps in order: ${shortInOrder.join(' ')}`);
}

const [mode, url, target, secondsArg] = process.argv.slice(2);
const seconds = Number(secondsArg ?? (mode === 'timeline' ? '12' : '60'));

if (url === undefined || target === undefined || (mode !== 'timeline' && mode !== 'gaps')) {
  console.error('usage: capture.mjs timeline <url> <filter> [seconds]');
  console.error('       capture.mjs gaps     <url> <topic>  [seconds]');
  process.exitCode = 2;
} else if (mode === 'timeline') {
  await timeline(url, target, seconds);
} else {
  await gaps(url, target, seconds);
}

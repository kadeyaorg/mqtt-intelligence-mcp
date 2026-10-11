/**
 * A fictional production line, published to MQTT.
 *
 * It exists so that discovery, the statistics and the payload views have something realistic
 * to look at: a namespace with several devices, the payload kinds the engine classifies,
 * retained state topics, one topic that moves fast, one topic the example configuration
 * forbids, and a scripted incident an agent can be asked about.
 *
 * Nothing here is a product, a protocol or a vendor. The line is made up, and so are the
 * topic names: any resemblance to a real plant is a coincidence of how factories are usually
 * laid out.
 *
 * Everything is driven by a seeded generator, so two runs with the same seed publish the same
 * numbers. An example that changes under you is an example you cannot reason about.
 */
import mqtt from 'mqtt';

const URL = process.env['MQTT_URL'] ?? 'mqtt://localhost:1883';
const SEED = Number(process.env['SIMULATOR_SEED'] ?? '20260101');
/** Seconds between two incidents. Short by default: an example should not be a wait. */
const INCIDENT_INTERVAL_S = Number(process.env['SIMULATOR_INCIDENT_INTERVAL_SECONDS'] ?? '180');
/** How long an incident lasts, from the first error to the line running again. */
const INCIDENT_DURATION_S = Number(process.env['SIMULATOR_INCIDENT_DURATION_SECONDS'] ?? '25');

const LINE = 'factory/line-01';

/** mulberry32: small, fast, and reproducible from one 32-bit seed. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const random = createRandom(SEED);

/** A value that drifts towards a centre instead of jumping about: machines are not dice. */
function drift(current: number, centre: number, amplitude: number): number {
  return current + (centre - current) * 0.1 + (random() - 0.5) * amplitude;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

type LineState = 'running' | 'fault' | 'recovering';

interface Machine {
  state: LineState;
  heartbeat: number;
  cycleCount: number;
  robotTemperatureC: number;
  robotSpeedPct: number;
  waterTempC: number;
  pressureBar: number;
  flowRateLpm: number;
  angleRad: number;
}

const machine: Machine = {
  state: 'running',
  heartbeat: 0,
  cycleCount: 0,
  robotTemperatureC: 41,
  robotSpeedPct: 100,
  waterTempC: 58,
  pressureBar: 3.2,
  flowRateLpm: 12,
  angleRad: 0,
};

const client = await mqtt.connectAsync(URL, {
  protocolVersion: 5,
  clientId: `line-01-simulator-${random().toString(16).slice(2, 10)}`,
  reconnectPeriod: 2000,
});

process.stderr.write(`simulator: publishing ${LINE}/... to ${URL}\n`);

interface PublishOptions {
  readonly retain?: boolean;
  readonly qos?: 0 | 1 | 2;
  readonly contentType?: string;
}

function publish(topic: string, payload: string | Uint8Array, options: PublishOptions = {}): void {
  void client.publishAsync(topic, Buffer.from(payload), {
    qos: options.qos ?? 0,
    retain: options.retain ?? false,
    ...(options.contentType === undefined
      ? {}
      : { properties: { contentType: options.contentType } }),
  });
}

function publishJson(topic: string, value: unknown, options: PublishOptions = {}): void {
  publish(topic, JSON.stringify(value), { contentType: 'application/json', ...options });
}

/** Every interval registered here is cleared on shutdown, so the container stops promptly. */
const timers: NodeJS.Timeout[] = [];
function every(milliseconds: number, run: () => void): void {
  timers.push(setInterval(run, milliseconds));
}

// --- Retained state: what a client learns the instant it subscribes ------------------------

function publishLineState(): void {
  const text =
    machine.state === 'running' ? 'RUNNING' : machine.state === 'fault' ? 'FAULT' : 'STARTING';
  publish(`${LINE}/plc/state`, text, { retain: true, qos: 1 });
}

function publishAlarm(active: boolean): void {
  publishJson(
    `${LINE}/hmi/alarm`,
    active
      ? {
          active: true,
          code: 42,
          text: 'Robot stopped: joint 3 over torque',
          since: new Date().toISOString(),
        }
      : { active: false },
    { retain: true, qos: 1 },
  );
}

// A retained description of the line, carrying a key the MCP server must redact before any
// model sees it. It is not a real credential, and it is here to be redacted.
publishJson(
  'factory/site/metadata',
  {
    site: 'Fictional Plant 1',
    line: 'line-01',
    commissioned: '2024-03-11',
    timezone: 'Europe/Paris',
    maintenanceApiKey: 'demo-key-not-a-real-secret',
  },
  { retain: true, qos: 1 },
);
publishLineState();
publishAlarm(false);

// A topic the example configuration denies. The simulator publishes it, the server must never
// store it, and it must appear in no answer.
every(5000, () => {
  publishJson(`${LINE}/plc/credentials/rotate`, {
    requestedBy: 'maintenance',
    password: 'never-leaves-the-broker',
  });
});

// --- Live telemetry -------------------------------------------------------------------------

every(1000, () => {
  machine.heartbeat += 1;
  publish(`${LINE}/plc/heartbeat`, String(machine.heartbeat));
});

every(500, () => {
  machine.angleRad = (machine.angleRad + (machine.state === 'running' ? 0.18 : 0)) % (Math.PI * 2);
  publishJson(`${LINE}/robot/position`, {
    x: round(Math.cos(machine.angleRad) * 420, 1),
    y: round(Math.sin(machine.angleRad) * 420, 1),
    z: round(180 + Math.sin(machine.angleRad * 2) * 40, 1),
    rz: round(machine.angleRad, 3),
  });
});

every(2000, () => {
  if (machine.state === 'running') {
    machine.cycleCount += 1;
    machine.robotTemperatureC = drift(machine.robotTemperatureC, 42, 0.6);
    machine.robotSpeedPct = drift(machine.robotSpeedPct, 100, 2);
  } else {
    machine.robotTemperatureC = drift(machine.robotTemperatureC, 57, 1.2);
    machine.robotSpeedPct = drift(machine.robotSpeedPct, 0, 1);
  }
  publishJson(`${LINE}/robot/status`, {
    state: machine.state === 'running' ? 'RUNNING' : 'STOPPED',
    cycleCount: machine.cycleCount,
    temperatureC: round(machine.robotTemperatureC, 1),
    speedPct: round(Math.max(0, machine.robotSpeedPct), 1),
  });
});

every(3000, () => {
  machine.waterTempC = drift(machine.waterTempC, machine.state === 'running' ? 58 : 44, 0.8);
  machine.pressureBar = drift(machine.pressureBar, machine.state === 'running' ? 3.2 : 0.4, 0.15);
  publishJson(`${LINE}/washer/status`, {
    state: machine.state === 'running' ? 'WASHING' : 'HOLD',
    waterTempC: round(machine.waterTempC, 1),
    pressureBar: round(machine.pressureBar, 2),
  });
});

every(1000, () => {
  machine.flowRateLpm = drift(machine.flowRateLpm, machine.state === 'running' ? 12 : 0, 0.5);
  publish(`${LINE}/washer/flow-rate`, String(round(Math.max(0, machine.flowRateLpm), 2)));
});

// One binary topic, so the payload classifier has something it must refuse to read as text.
every(5000, () => {
  const frame = new Uint8Array(512);
  // A PNG magic number, then noise: enough to look like a real frame header.
  frame.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let index = 8; index < frame.length; index += 1) {
    frame[index] = Math.floor(random() * 256);
  }
  publish(`${LINE}/camera/frame`, frame, { contentType: 'image/png' });
});

// --- The incident ----------------------------------------------------------------------------

/**
 * A scripted failure, so that "what happened on line 01?" has an answer.
 *
 * The washer stops just over a second after the robot reports its error. That gap is the point
 * of the example: the two events are close in time, the server reports both as facts with
 * their receipt times, and it is for the person reading to decide whether one caused the
 * other. The engine never says so.
 */
function runIncident(): void {
  machine.state = 'fault';
  publishJson(
    `${LINE}/robot/error`,
    {
      code: 42,
      message: 'Joint 3 over torque during pick',
      severity: 'critical',
      joint: 3,
      torqueNm: round(118 + random() * 6, 1),
    },
    { qos: 1 },
  );
  publishLineState();
  publishAlarm(true);

  timers.push(
    setTimeout(() => {
      publishJson(`${LINE}/washer/status`, {
        state: 'HOLD',
        reason: 'UPSTREAM_STOPPED',
        waterTempC: round(machine.waterTempC, 1),
        pressureBar: round(machine.pressureBar, 2),
      });
    }, 1200),
  );

  timers.push(
    setTimeout(() => {
      machine.state = 'recovering';
      publishLineState();
      publishAlarm(false);
      publishJson(
        `${LINE}/robot/error`,
        { code: 0, message: 'Cleared by operator', severity: 'info' },
        { qos: 1 },
      );
    }, INCIDENT_DURATION_S * 1000),
  );

  timers.push(
    setTimeout(
      () => {
        machine.state = 'running';
        publishLineState();
      },
      (INCIDENT_DURATION_S + 5) * 1000,
    ),
  );
}

every(INCIDENT_INTERVAL_S * 1000, runIncident);

// --- Shutdown ---------------------------------------------------------------------------------

async function stop(): Promise<void> {
  for (const timer of timers) {
    clearInterval(timer);
    clearTimeout(timer);
  }
  await client.endAsync();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void stop().then(
      () => {
        process.exit(0);
      },
      () => {
        process.exit(1);
      },
    );
  });
}

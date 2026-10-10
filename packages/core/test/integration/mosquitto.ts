/**
 * A real Eclipse Mosquitto, started per test file.
 *
 * Unit tests prove the state machine reacts correctly to scripted events; these prove the
 * events we script are the ones a real broker produces. Authentication refusals, SUBACK
 * failures and a socket dying mid-stream are exactly the cases where a mocked transport can
 * quietly disagree with reality.
 */
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export const MOSQUITTO_IMAGE = 'eclipse-mosquitto:2.0';
const MQTT_PORT = 1883;

export interface MosquittoCredentials {
  readonly username: string;
  readonly password: string;
}

export interface MosquittoTls {
  readonly caCertificate: Uint8Array;
  readonly serverCertificate: Uint8Array;
  readonly serverKey: Uint8Array;
  /** Demands a client certificate signed by the same authority. */
  readonly requireClientCertificate?: boolean;
}

export interface MosquittoOptions {
  /** When set, anonymous access is refused and these credentials are the only valid ones. */
  readonly credentials?: MosquittoCredentials;
  /** Mosquitto ACL file contents, used to make the broker refuse some subscriptions. */
  readonly acl?: string;
  /**
   * Binds the broker to this host port instead of a random one.
   *
   * Restarting a container reassigns a random mapping, which would move the broker out from
   * under a client that is trying to reconnect. Reconnection tests pin the port instead.
   */
  readonly hostPort?: number;
  /** Serves TLS instead of plain TCP. */
  readonly tls?: MosquittoTls;
}

export interface RunningMosquitto {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  /** Stops the broker without removing the container, to test reconnection. */
  restart(): Promise<RunningMosquitto>;
  stop(): Promise<void>;
}

function configurationFor(options: MosquittoOptions): string {
  const lines = [`listener ${String(MQTT_PORT)}`, 'log_type all'];
  if (options.tls !== undefined) {
    lines.push(
      'cafile /mosquitto/config/ca.crt',
      'certfile /mosquitto/config/server.crt',
      'keyfile /mosquitto/config/server.key',
      `require_certificate ${options.tls.requireClientCertificate === true ? 'true' : 'false'}`,
    );
  }
  if (options.credentials === undefined) {
    lines.push('allow_anonymous true');
  } else {
    lines.push('allow_anonymous false', 'password_file /mosquitto/config/passwd');
  }
  if (options.acl !== undefined) {
    lines.push('acl_file /mosquitto/config/acl');
  }
  return `${lines.join('\n')}\n`;
}

function startupCommand(options: MosquittoOptions): string[] {
  const steps: string[] = [];
  if (options.credentials !== undefined) {
    const { username, password } = options.credentials;
    steps.push(
      `mosquitto_passwd -b -c /mosquitto/config/passwd '${username}' '${password}'`,
      // The entrypoint runs as root, the broker drops to the mosquitto user: without this
      // it cannot read the 0600 file it just created.
      'chmod 0644 /mosquitto/config/passwd',
    );
  }
  steps.push('exec mosquitto -c /mosquitto/config/mosquitto.conf');
  return ['sh', '-c', steps.join(' && ')];
}

export async function startMosquitto(options: MosquittoOptions = {}): Promise<RunningMosquitto> {
  let container = new GenericContainer(MOSQUITTO_IMAGE)
    .withExposedPorts(
      options.hostPort === undefined ? MQTT_PORT : { container: MQTT_PORT, host: options.hostPort },
    )
    .withCopyContentToContainer([
      {
        content: configurationFor(options),
        target: '/mosquitto/config/mosquitto.conf',
        mode: 0o644,
      },
    ])
    .withCommand(startupCommand(options))
    .withWaitStrategy(Wait.forLogMessage(/mosquitto version .* running/u));

  if (options.acl !== undefined) {
    container = container.withCopyContentToContainer([
      { content: options.acl, target: '/mosquitto/config/acl', mode: 0o644 },
    ]);
  }

  if (options.tls !== undefined) {
    container = container.withCopyContentToContainer([
      {
        content: Buffer.from(options.tls.caCertificate),
        target: '/mosquitto/config/ca.crt',
        mode: 0o644,
      },
      {
        content: Buffer.from(options.tls.serverCertificate),
        target: '/mosquitto/config/server.crt',
        mode: 0o644,
      },
      {
        content: Buffer.from(options.tls.serverKey),
        target: '/mosquitto/config/server.key',
        // Readable by the mosquitto user, which the broker becomes after start-up.
        mode: 0o644,
      },
    ]);
  }

  return describe(await container.start(), options.tls !== undefined);
}

function describe(started: StartedTestContainer, secure = false): RunningMosquitto {
  const host = started.getHost();
  const port = started.getMappedPort(MQTT_PORT);

  return {
    url: `${secure ? 'mqtts' : 'mqtt'}://${host}:${String(port)}`,
    host,
    port,
    async restart(): Promise<RunningMosquitto> {
      await started.restart();
      // With a pinned host port the address survives the restart, which is what lets a
      // reconnecting client find the broker again.
      return describe(started, secure);
    },
    async stop(): Promise<void> {
      await started.stop();
    },
  };
}

/** Finds a free host port, so a restartable broker keeps the same address. */
export async function freeHostPort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

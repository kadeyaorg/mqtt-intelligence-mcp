/**
 * TLS and mutual TLS against a real broker.
 *
 * This is how the engine is meant to reach anything beyond a laptop, so the handshake is
 * worth proving end to end: a certificate the client does not trust must fail, and a private
 * key must travel wrapped in a `Secret` all the way to the socket.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TransportOptions } from '../../src/index.js';
import { MqttJsTransportFactory, parseTopicFilter, Secret } from '../../src/index.js';
import type { TestCertificates } from './certificates.js';
import { createTestCertificates, opensslAvailable } from './certificates.js';
import type { RunningMosquitto } from './mosquitto.js';
import { startMosquitto } from './mosquitto.js';

const factory = new MqttJsTransportFactory();

const handlers = {
  onMessage: (): void => undefined,
  onDisconnect: (): void => undefined,
};

function optionsFor(
  broker: RunningMosquitto,
  overrides: Partial<TransportOptions>,
): TransportOptions {
  return {
    url: broker.url,
    protocolVersion: 5,
    clientId: `mqtt-intel-tls-${Math.random().toString(16).slice(2, 10)}`,
    keepaliveSeconds: 10,
    connectTimeoutMs: 5000,
    ...overrides,
  };
}

const hasOpenssl = await opensslAvailable();

describe.skipIf(!hasOpenssl)('a broker serving TLS', () => {
  let certificates: TestCertificates;
  let broker: RunningMosquitto;

  beforeAll(async () => {
    certificates = await createTestCertificates();
    broker = await startMosquitto({
      tls: {
        caCertificate: certificates.caCertificate,
        serverCertificate: certificates.serverCertificate,
        serverKey: certificates.serverKey,
      },
    });
  }, 180_000);

  afterAll(async () => {
    await broker.stop();
    await certificates.cleanup();
  });

  it('connects when the certificate authority is trusted', async () => {
    const transport = factory.create(
      optionsFor(broker, {
        tls: {
          ca: certificates.caCertificate,
          serverName: certificates.serverName,
          rejectUnauthorized: true,
        },
      }),
      handlers,
    );

    const result = await transport.connect();
    const outcome = await transport.subscribe(parseTopicFilter('factory/#'), { qos: 0 });
    await transport.close();

    expect(result.sessionPresent).toBe(false);
    expect(outcome.granted).toBe(true);
  });

  it('refuses a server it cannot verify', async () => {
    const transport = factory.create(
      optionsFor(broker, {
        tls: { serverName: certificates.serverName, rejectUnauthorized: true },
      }),
      handlers,
    );

    await expect(transport.connect()).rejects.toMatchObject({ code: 'BROKER_TLS_ERROR' });
    await transport.close();
  });

  it('connects without verification only when explicitly told to', async () => {
    const transport = factory.create(
      optionsFor(broker, { tls: { rejectUnauthorized: false } }),
      handlers,
    );

    await expect(transport.connect()).resolves.toMatchObject({ sessionPresent: false });
    await transport.close();
  });
});

describe.skipIf(!hasOpenssl)('a broker demanding a client certificate', () => {
  let certificates: TestCertificates;
  let broker: RunningMosquitto;

  beforeAll(async () => {
    certificates = await createTestCertificates();
    broker = await startMosquitto({
      tls: {
        caCertificate: certificates.caCertificate,
        serverCertificate: certificates.serverCertificate,
        serverKey: certificates.serverKey,
        requireClientCertificate: true,
      },
    });
  }, 180_000);

  afterAll(async () => {
    await broker.stop();
    await certificates.cleanup();
  });

  it('connects with a client certificate, the private key never leaving its Secret', async () => {
    const key = new Secret(certificates.clientKey, 'file:client.key');
    const transport = factory.create(
      optionsFor(broker, {
        tls: {
          ca: certificates.caCertificate,
          cert: certificates.clientCertificate,
          key,
          serverName: certificates.serverName,
          rejectUnauthorized: true,
        },
      }),
      handlers,
    );

    await expect(transport.connect()).resolves.toMatchObject({ sessionPresent: false });
    await transport.close();

    expect(JSON.stringify({ key })).not.toContain('PRIVATE KEY');
  });

  it('is refused without one', async () => {
    const transport = factory.create(
      optionsFor(broker, {
        tls: {
          ca: certificates.caCertificate,
          serverName: certificates.serverName,
          rejectUnauthorized: true,
        },
      }),
      handlers,
    );

    const failure = await transport.connect().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    await transport.close();

    // Brokers differ: some fail the handshake, some accept it and then refuse the session.
    expect(failure).toMatchObject({ name: 'BrokerError' });
    expect(['BROKER_TLS_ERROR', 'BROKER_CONNECTION_FAILED']).toContain(
      (failure as { code: string }).code,
    );
  });
});

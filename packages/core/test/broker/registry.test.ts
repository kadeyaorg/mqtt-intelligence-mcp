import { describe, expect, it } from 'vitest';
import type { BrokerConnectionOptions } from '../../src/index.js';
import { BrokerRegistry, parseBrokerId } from '../../src/index.js';
import { FakeClock, FakeTransportFactory } from '../../src/testing/index.js';

const FACTORY = parseBrokerId('factory-fr');
const STAGING = parseBrokerId('staging');

function brokerOptions(brokerId: typeof FACTORY, port: number): BrokerConnectionOptions {
  return {
    brokerId,
    transport: {
      url: `mqtt://localhost:${String(port)}`,
      protocolVersion: 5,
      clientId: `mqtt-intel-${brokerId}`,
      keepaliveSeconds: 30,
      connectTimeoutMs: 5000,
    },
    reconnect: { initialDelayMs: 1000, maxDelayMs: 60_000 },
  };
}

function registryOf(...brokers: BrokerConnectionOptions[]) {
  const transports = new FakeTransportFactory();
  const registry = new BrokerRegistry(brokers, {
    transportFactory: transports,
    clock: new FakeClock(),
  });
  return { registry, transports };
}

describe('resolving a broker', () => {
  it('uses the only configured broker when none is named', () => {
    const { registry } = registryOf(brokerOptions(FACTORY, 1883));

    expect(registry.resolve().brokerId).toBe(FACTORY);
    expect(registry.resolve(FACTORY).brokerId).toBe(FACTORY);
  });

  it('refuses to guess between several brokers, and lists them', () => {
    const { registry } = registryOf(brokerOptions(FACTORY, 1883), brokerOptions(STAGING, 1884));

    expect(() => registry.resolve()).toThrow(
      expect.objectContaining({ code: 'BROKER_AMBIGUOUS' }) as Error,
    );
    try {
      registry.resolve();
    } catch (error) {
      expect((error as Error).message).toContain('factory-fr, staging');
    }
  });

  it('names the configured brokers when asked for an unknown one', () => {
    const { registry } = registryOf(brokerOptions(FACTORY, 1883));

    try {
      registry.resolve(STAGING);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({ code: 'BROKER_NOT_FOUND' });
      expect((error as Error).message).toContain('factory-fr');
    }
  });

  it('reports an empty configuration as such', () => {
    const { registry } = registryOf();

    expect(() => registry.resolve()).toThrow(
      expect.objectContaining({ code: 'BROKER_NOT_FOUND' }) as Error,
    );
    expect(registry.ids).toEqual([]);
  });
});

describe('connecting several brokers', () => {
  it('keeps one broker working while another refuses credentials', async () => {
    const transports = new FakeTransportFactory();
    const registry = new BrokerRegistry(
      [brokerOptions(FACTORY, 1883), brokerOptions(STAGING, 1884)],
      { transportFactory: transports, clock: new FakeClock() },
    );

    // The staging transport fails; the factory one is created first and succeeds.
    const [factory, staging] = registry.connections;
    await factory?.ensureConnected();
    transports.connectBehaviour = { type: 'fail', error: new Error('ECONNREFUSED') };
    await staging?.ensureConnected().catch(() => undefined);

    expect(factory?.status.state).toBe('connected');
    expect(staging?.status.state).toBe('backoff');
    expect(registry.statuses().map((status) => status.state)).toEqual(['connected', 'backoff']);
  });

  it('connects everything without letting one failure stop the others', async () => {
    const transports = new FakeTransportFactory();
    const registry = new BrokerRegistry(
      [brokerOptions(FACTORY, 1883), brokerOptions(STAGING, 1884)],
      { transportFactory: transports, clock: new FakeClock() },
    );

    await registry.connectAll();

    expect(registry.statuses().every((status) => status.state === 'connected')).toBe(true);
  });

  it('closes every broker', async () => {
    const { registry, transports } = registryOf(
      brokerOptions(FACTORY, 1883),
      brokerOptions(STAGING, 1884),
    );
    await registry.connectAll();

    await registry.closeAll();

    expect(registry.statuses().map((status) => status.state)).toEqual(['closed', 'closed']);
    expect(transports.created.every((transport) => transport.closeCount === 1)).toBe(true);
  });
});

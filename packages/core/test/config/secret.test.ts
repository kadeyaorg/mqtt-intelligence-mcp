import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { REDACTED, Secret } from '../../src/index.js';

const VALUE = 'sup3r-s3cret-value';

describe('Secret', () => {
  it('returns the value only to a caller that asks for it explicitly', () => {
    const secret = new Secret(VALUE, 'env:MQTT_PASSWORD');

    expect(secret.reveal()).toBe(VALUE);
    expect(secret.source).toBe('env:MQTT_PASSWORD');
    expect(secret.length).toBe(VALUE.length);
  });

  it.each([
    ['String()', (secret: Secret) => String(secret)],
    [
      'a template literal',
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- interpolating a secret by accident is exactly the mistake this test guards against
      (secret: Secret) => `${secret}`,
    ],
    ['string concatenation', (secret: Secret) => `password: ${String(secret)}`],
    ['JSON.stringify', (secret: Secret) => JSON.stringify(secret)],
    ['JSON.stringify of a containing object', (secret: Secret) => JSON.stringify({ secret })],
    ['util.inspect', (secret: Secret) => inspect(secret)],
    ['util.inspect of a containing object', (secret: Secret) => inspect({ auth: { secret } })],
    ['console-style formatting', (secret: Secret) => inspect({ secret }, { depth: 10 })],
  ])('does not leak through %s', (_case, render) => {
    const rendered = render(new Secret(VALUE, 'env:MQTT_PASSWORD'));

    expect(rendered).not.toContain(VALUE);
    expect(rendered).toContain(REDACTED);
  });

  it('does not leak through its own enumerable properties', () => {
    const secret = new Secret(VALUE, 'env:MQTT_PASSWORD');

    expect(Object.keys(secret)).toEqual(['source']);
    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- a careless spread must not expose the value either
    expect(JSON.stringify({ ...secret })).not.toContain(VALUE);
    expect(Object.getOwnPropertyNames(secret)).not.toContain('value');
  });

  it('does not leak through an error message built from it', () => {
    const secret = new Secret(VALUE, 'env:MQTT_PASSWORD');

    const error = new Error(`connect failed with password ${String(secret)}`);

    expect(error.message).not.toContain(VALUE);
  });

  it('wraps binary material, such as a TLS private key', () => {
    const bytes = new TextEncoder().encode('-----BEGIN PRIVATE KEY-----');
    const secret = new Secret<Uint8Array>(bytes, 'file:./client.key');

    expect(secret.reveal()).toBe(bytes);
    expect(secret.length).toBe(bytes.length);
    expect(inspect(secret)).not.toContain('BEGIN PRIVATE KEY');
    expect(JSON.stringify({ key: secret })).toBe(`{"key":"${REDACTED}"}`);
  });
});

/**
 * A throwaway certificate authority for TLS integration tests.
 *
 * TLS and mutual TLS are how this engine is meant to reach a production broker, so they are
 * worth proving against a real handshake rather than a mock. Everything here is generated
 * per run, lives in a temporary directory, and never leaves it.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface TestCertificates {
  readonly directory: string;
  readonly caCertificate: Uint8Array;
  readonly serverCertificate: Uint8Array;
  readonly serverKey: Uint8Array;
  readonly clientCertificate: Uint8Array;
  readonly clientKey: Uint8Array;
  /** The name the server certificate is issued for. */
  readonly serverName: string;
  cleanup(): Promise<void>;
}

export async function opensslAvailable(): Promise<boolean> {
  try {
    await run('openssl', ['version']);
    return true;
  } catch {
    return false;
  }
}

async function generateKeyAndCertificate(
  directory: string,
  name: string,
  commonName: string,
  ca: { readonly certificate: string; readonly key: string } | undefined,
): Promise<void> {
  const keyPath = join(directory, `${name}.key`);
  const certificatePath = join(directory, `${name}.crt`);
  await run('openssl', ['genrsa', '-out', keyPath, '2048']);

  if (ca === undefined) {
    await run('openssl', [
      'req',
      '-x509',
      '-new',
      '-key',
      keyPath,
      '-days',
      '1',
      '-subj',
      `/CN=${commonName}`,
      '-out',
      certificatePath,
    ]);
    return;
  }

  const csrPath = join(directory, `${name}.csr`);
  await run('openssl', [
    'req',
    '-new',
    '-key',
    keyPath,
    '-subj',
    `/CN=${commonName}`,
    '-out',
    csrPath,
  ]);
  const extensionsPath = join(directory, `${name}.ext`);
  await writeFile(
    extensionsPath,
    `subjectAltName = DNS:${commonName}, DNS:localhost, IP:127.0.0.1\n`,
    'utf8',
  );
  await run('openssl', [
    'x509',
    '-req',
    '-in',
    csrPath,
    '-CA',
    ca.certificate,
    '-CAkey',
    ca.key,
    '-CAcreateserial',
    '-days',
    '1',
    '-extfile',
    extensionsPath,
    '-out',
    certificatePath,
  ]);
}

/** Generates a CA, a server certificate and a client certificate, valid for one day. */
export async function createTestCertificates(serverName = 'localhost'): Promise<TestCertificates> {
  const directory = await mkdtemp(join(tmpdir(), 'mqtt-intelligence-tls-'));
  await generateKeyAndCertificate(directory, 'ca', 'mqtt-intelligence-test-ca', undefined);
  const ca = { certificate: join(directory, 'ca.crt'), key: join(directory, 'ca.key') };
  await generateKeyAndCertificate(directory, 'server', serverName, ca);
  await generateKeyAndCertificate(directory, 'client', 'mqtt-intelligence-test-client', ca);

  const read = async (name: string): Promise<Uint8Array> => readFile(join(directory, name));

  return {
    directory,
    serverName,
    caCertificate: await read('ca.crt'),
    serverCertificate: await read('server.crt'),
    serverKey: await read('server.key'),
    clientCertificate: await read('client.crt'),
    clientKey: await read('client.key'),
    async cleanup(): Promise<void> {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

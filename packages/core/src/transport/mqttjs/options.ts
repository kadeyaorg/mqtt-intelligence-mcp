/**
 * Mapping our transport options onto mqtt.js client options.
 *
 * The defaults that matter are the ones we turn **off** (ADR-0006):
 *
 * - `reconnectPeriod: 0` — reconnection is a policy decision, made by `BrokerConnection`,
 *   which distinguishes a network blip from refused credentials.
 * - `resubscribe: false` — the subscription manager owns the desired state; mqtt.js also
 *   loses topics named `__proto__` when it resubscribes on its own (upstream PR #2058).
 * - `clean: true` with `sessionExpiryInterval: 0` — a persistent session would make the
 *   broker queue messages for us while we are away, spending its memory for data we would
 *   not count as live anyway.
 */
import type { IClientOptions } from 'mqtt';
import type { TransportOptions } from '../port.js';

/** Our client is a passive observer: it never needs a will. */
export function toClientOptions(options: TransportOptions): IClientOptions {
  const tls = options.tls;
  const username =
    typeof options.username === 'string' ? options.username : options.username?.reveal();

  const clientOptions: IClientOptions = {
    clientId: options.clientId,
    protocolVersion: options.protocolVersion,
    clean: true,
    keepalive: options.keepaliveSeconds,
    connectTimeout: options.connectTimeoutMs,
    reconnectPeriod: 0,
    resubscribe: false,
    manualConnect: true,
    ...(username === undefined ? {} : { username }),
    ...(options.password === undefined ? {} : { password: options.password.reveal() }),
  };

  if (options.protocolVersion === 5) {
    clientOptions.properties = {
      sessionExpiryInterval: 0,
      // Ask the broker not to send what we would discard, and refuse topic aliases by not
      // advertising any: we never resolve them.
      ...(options.maximumPacketSize === undefined
        ? {}
        : { maximumPacketSize: options.maximumPacketSize }),
      topicAliasMaximum: 0,
    };
  }

  if (tls !== undefined) {
    clientOptions.rejectUnauthorized = tls.rejectUnauthorized;
    if (tls.ca !== undefined) {
      clientOptions.ca = Buffer.from(tls.ca);
    }
    if (tls.cert !== undefined) {
      clientOptions.cert = Buffer.from(tls.cert);
    }
    if (tls.key !== undefined) {
      // mqtt.js types mention keyPath, but its connect code never reads it: pass the bytes.
      clientOptions.key = Buffer.from(tls.key.reveal());
    }
    if (tls.keyPassphrase !== undefined) {
      // Not in mqtt.js types, but passed through to Node's TLS options.
      (clientOptions as { passphrase?: string }).passphrase = tls.keyPassphrase.reveal();
    }
    if (tls.serverName !== undefined) {
      clientOptions.servername = tls.serverName;
    }
    if (tls.alpn !== undefined && tls.alpn.length > 0) {
      clientOptions.ALPNProtocols = [...tls.alpn];
    }
  }

  return clientOptions;
}

/**
 * A publisher for integration tests.
 *
 * The transport port has no `publish`, deliberately: the engine is read-only. Tests still
 * need traffic to observe, so they drive mqtt.js directly here, outside the engine.
 */
import mqtt from 'mqtt';

export interface TestMessage {
  readonly topic: string;
  readonly payload: string;
  readonly retain?: boolean;
  readonly qos?: 0 | 1 | 2;
}

export interface PublishOptions {
  readonly username?: string;
  readonly password?: string;
}

export async function publishMessages(
  url: string,
  messages: readonly TestMessage[],
  options: PublishOptions = {},
): Promise<void> {
  const client = await mqtt.connectAsync(url, {
    protocolVersion: 5,
    reconnectPeriod: 0,
    ...(options.username === undefined ? {} : { username: options.username }),
    ...(options.password === undefined ? {} : { password: options.password }),
  });
  try {
    for (const message of messages) {
      await client.publishAsync(message.topic, message.payload, {
        qos: message.qos ?? 1,
        retain: message.retain ?? false,
      });
    }
  } finally {
    await client.endAsync();
  }
}

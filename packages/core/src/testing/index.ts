/**
 * Test helpers published as `@kadeya/mqtt-intel-core/testing`.
 *
 * They exist so that users of the library, and future storage or transport adapters, can
 * test against the same fakes and contract suites the engine uses.
 */

export { FakeClock } from './fake-clock.js';
export type { FakeClockOptions } from './fake-clock.js';

export { createRecordingLogger } from './recording-logger.js';
export type { RecordedLine, RecordingLogger } from './recording-logger.js';

export { InMemoryMetricsRecorder } from './in-memory-metrics.js';
export type { Measurement } from './in-memory-metrics.js';

export { FakeTransport, FakeTransportFactory } from './fake-transport.js';
export type { ConnectBehaviour, FakeSubscription } from './fake-transport.js';

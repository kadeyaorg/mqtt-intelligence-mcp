/**
 * Test helpers published as `@kadeya/mqtt-intel-core/testing`.
 *
 * They exist so that users of the library, and future storage or transport adapters, can
 * test against the same fakes and contract suites the engine uses.
 */

export { FakeClock } from './fake-clock.js';
export type { FakeClockOptions } from './fake-clock.js';

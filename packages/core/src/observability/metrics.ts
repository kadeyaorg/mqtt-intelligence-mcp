/**
 * The `MetricsRecorder` port (ADR-0015).
 *
 * The engine must be able to say how degraded its own view is: messages dropped, topics
 * evicted, subscriptions refused, reconnections. The shape mirrors OpenTelemetry's
 * instruments, so the bridge planned for V0.4 is a thin adapter rather than a translation,
 * but nothing here depends on an OpenTelemetry package.
 *
 * The default implementation does nothing, so metrics cost nothing until someone wires them.
 */

export type MetricAttributeValue = string | number | boolean;
export type MetricAttributes = Readonly<Record<string, MetricAttributeValue>>;

export interface MetricOptions {
  readonly description?: string;
  /** UCUM unit, for example `ms`, `By`, `{message}`. */
  readonly unit?: string;
}

/** Monotonically increasing total, such as messages received. */
export interface Counter {
  add(value: number, attributes?: MetricAttributes): void;
}

/** A total that can go down, such as the number of tracked topics. */
export interface UpDownCounter {
  add(value: number, attributes?: MetricAttributes): void;
}

/** A distribution, such as connection duration. */
export interface Histogram {
  record(value: number, attributes?: MetricAttributes): void;
}

export interface MetricsRecorder {
  counter(name: string, options?: MetricOptions): Counter;
  upDownCounter(name: string, options?: MetricOptions): UpDownCounter;
  histogram(name: string, options?: MetricOptions): Histogram;
}

const noopCounter: Counter & UpDownCounter = { add: () => undefined };
const noopHistogram: Histogram = { record: () => undefined };

export const noopMetrics: MetricsRecorder = {
  counter: () => noopCounter,
  upDownCounter: () => noopCounter,
  histogram: () => noopHistogram,
};

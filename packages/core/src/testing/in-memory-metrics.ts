/**
 * A `MetricsRecorder` that keeps every measurement, so a test can assert that the engine
 * reported its own degradation: dropped payloads, evicted topics, refused subscriptions.
 */
import type {
  Counter,
  Histogram,
  MetricAttributes,
  MetricOptions,
  MetricsRecorder,
  UpDownCounter,
} from '../observability/index.js';

export interface Measurement {
  readonly name: string;
  readonly value: number;
  readonly attributes: MetricAttributes;
}

function matches(measurement: Measurement, attributes: MetricAttributes | undefined): boolean {
  if (attributes === undefined) {
    return true;
  }
  return Object.entries(attributes).every(([key, value]) => measurement.attributes[key] === value);
}

export class InMemoryMetricsRecorder implements MetricsRecorder {
  readonly #measurements: Measurement[] = [];
  readonly #instruments = new Map<string, MetricOptions>();

  get measurements(): readonly Measurement[] {
    return this.#measurements;
  }

  /** Every measurement of one instrument, optionally narrowed by attributes. */
  recorded(name: string, attributes?: MetricAttributes): readonly Measurement[] {
    return this.#measurements.filter(
      (measurement) => measurement.name === name && matches(measurement, attributes),
    );
  }

  /** Sum of the values recorded for one instrument. */
  total(name: string, attributes?: MetricAttributes): number {
    return this.recorded(name, attributes).reduce((sum, measurement) => sum + measurement.value, 0);
  }

  /** Options the instrument was declared with, to check names, units and descriptions. */
  instrument(name: string): MetricOptions | undefined {
    return this.#instruments.get(name);
  }

  clear(): void {
    this.#measurements.length = 0;
  }

  counter(name: string, options?: MetricOptions): Counter {
    return this.#instrument(name, options);
  }

  upDownCounter(name: string, options?: MetricOptions): UpDownCounter {
    return this.#instrument(name, options);
  }

  histogram(name: string, options?: MetricOptions): Histogram {
    this.#instruments.set(name, options ?? {});
    const record = this.#record.bind(this, name);
    return { record };
  }

  #instrument(name: string, options: MetricOptions | undefined): Counter & UpDownCounter {
    this.#instruments.set(name, options ?? {});
    const add = this.#record.bind(this, name);
    return { add };
  }

  #record(name: string, value: number, attributes: MetricAttributes = {}): void {
    this.#measurements.push({ name, value, attributes });
  }
}

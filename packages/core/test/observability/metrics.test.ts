import { describe, expect, it } from 'vitest';
import { noopMetrics } from '../../src/index.js';
import { InMemoryMetricsRecorder } from '../../src/testing/index.js';

describe('noopMetrics', () => {
  it('accepts every instrument and measurement without doing anything', () => {
    expect(() => {
      noopMetrics.counter('mqtt_intelligence.messages.received').add(1, { broker: 'factory-fr' });
      noopMetrics.upDownCounter('mqtt_intelligence.topics.tracked').add(-1);
      noopMetrics.histogram('mqtt_intelligence.ingest.flush.duration', { unit: 'ms' }).record(12);
    }).not.toThrow();
  });
});

describe('InMemoryMetricsRecorder', () => {
  it('records counters with their attributes', () => {
    const metrics = new InMemoryMetricsRecorder();
    const received = metrics.counter('mqtt_intelligence.messages.received');

    received.add(3, { broker: 'factory-fr' });
    received.add(2, { broker: 'factory-fr' });
    received.add(7, { broker: 'staging' });

    expect(metrics.total('mqtt_intelligence.messages.received')).toBe(12);
    expect(metrics.total('mqtt_intelligence.messages.received', { broker: 'factory-fr' })).toBe(5);
    expect(metrics.recorded('mqtt_intelligence.messages.received', { broker: 'staging' })).toEqual([
      { name: 'mqtt_intelligence.messages.received', value: 7, attributes: { broker: 'staging' } },
    ]);
  });

  it('records a counter going down and a histogram', () => {
    const metrics = new InMemoryMetricsRecorder();

    metrics.upDownCounter('mqtt_intelligence.topics.tracked').add(10);
    metrics.upDownCounter('mqtt_intelligence.topics.tracked').add(-4);
    metrics.histogram('mqtt_intelligence.ingest.flush.duration').record(12);
    metrics.histogram('mqtt_intelligence.ingest.flush.duration').record(8);

    expect(metrics.total('mqtt_intelligence.topics.tracked')).toBe(6);
    expect(metrics.recorded('mqtt_intelligence.ingest.flush.duration').map((m) => m.value)).toEqual(
      [12, 8],
    );
  });

  it('keeps the declared unit and description, so instrument names can be asserted', () => {
    const metrics = new InMemoryMetricsRecorder();

    metrics.histogram('mqtt_intelligence.broker.connect.duration', {
      unit: 'ms',
      description: 'Time to establish a broker connection.',
    });

    expect(metrics.instrument('mqtt_intelligence.broker.connect.duration')).toEqual({
      unit: 'ms',
      description: 'Time to establish a broker connection.',
    });
    expect(metrics.instrument('absent')).toBeUndefined();
  });

  it('reports no measurement for an instrument that was never used', () => {
    const metrics = new InMemoryMetricsRecorder();

    expect(metrics.total('mqtt_intelligence.payloads.dropped')).toBe(0);
    expect(metrics.recorded('mqtt_intelligence.payloads.dropped')).toEqual([]);
  });

  it('clears what it recorded', () => {
    const metrics = new InMemoryMetricsRecorder();
    metrics.counter('a').add(1);

    metrics.clear();

    expect(metrics.measurements).toEqual([]);
  });
});

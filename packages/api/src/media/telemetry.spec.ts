import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { createMediaLifecycleObserver, observeMedia, withMediaAttempt } from './telemetry';

it('keeps durable job correlation in traces while limiting metrics to finite lifecycle dimensions', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const metrics = jest.fn();
  const observer = createMediaLifecycleObserver({
    tracer: provider.getTracer('test'),
    metrics,
    now: () => 5000,
  });
  observer({
    jobId: 'durable-job',
    tenantId: 'tenant-a',
    api: 'openai.images',
    operation: 'image.generate',
    kind: 'transition',
    phase: 'requires_attention',
    previousPhase: 'submitting',
    result: 'completed',
    durationMs: 1200,
    version: 7,
  });
  observer({
    jobId: 'durable-job',
    tenantId: 'tenant-a',
    api: 'openai.images',
    operation: 'image.generate',
    kind: 'settlement',
    phase: 'failed',
    result: 'completed',
    durationMs: 500,
    version: 11,
  });
  await provider.forceFlush();
  expect(exporter.getFinishedSpans()).toHaveLength(2);
  for (const span of exporter.getFinishedSpans()) {
    expect(span.attributes).toMatchObject({
      'librechat.media.job.id': 'durable-job',
      'librechat.tenant.id': 'tenant-a',
    });
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  }
  expect(metrics.mock.calls[0][0]).not.toHaveProperty('jobId');
  expect(metrics.mock.calls[0][0]).not.toHaveProperty('tenantId');
  expect(exporter.getFinishedSpans()[0].duration).toEqual([1, 200_000_000]);
  await provider.shutdown();
});

it('isolates broken metrics and lifecycle exporters, including disabled telemetry', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const observer = createMediaLifecycleObserver({
    tracer: provider.getTracer('test'),
    metrics: () => {
      throw new Error('offline');
    },
  });
  expect(() => observeMedia(observer, { kind: 'cleanup', result: 'failed' })).not.toThrow();
  expect(() =>
    observeMedia(
      () => {
        throw new Error('offline');
      },
      { kind: 'attempt', result: 'started' },
    ),
  ).not.toThrow();
  expect(() => observeMedia(undefined, { kind: 'attempt', result: 'started' })).not.toThrow();
  await provider.forceFlush();
  expect(exporter.getFinishedSpans()).toHaveLength(1);
  expect(exporter.getFinishedSpans()[0].events).toEqual([]);
  await provider.shutdown();
});

it('keeps the attempt span active across awaits and nests provider spans and durable events', async () => {
  const manager = new AsyncHooksContextManager().enable();
  context.setGlobalContextManager(manager);
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const tracer = provider.getTracer('test');
  const observer = createMediaLifecycleObserver({ tracer });
  const event = {
    kind: 'attempt' as const,
    result: 'started' as const,
    jobId: 'job',
    tenantId: 'tenant',
  };
  try {
    await withMediaAttempt(observer, event, async () => {
      observer(event);
      await Promise.resolve();
      expect(trace.getSpan(context.active())).toBeDefined();
      const child = tracer.startSpan('provider');
      child.end();
      observer({ ...event, kind: 'transition', phase: 'running', result: 'completed' });
      expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['provider']);
    });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const attempt = spans.find((span) => span.name === 'librechat.media.attempt')!;
    expect(spans[0].parentSpanContext?.spanId).toBe(attempt.spanContext().spanId);
    expect(attempt.events.map((event) => event.name)).toEqual([
      'media.attempt',
      'media.transition',
    ]);
  } finally {
    context.disable();
    manager.disable();
    await provider.shutdown();
  }
});

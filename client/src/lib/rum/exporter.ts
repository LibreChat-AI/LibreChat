import { resourceFromAttributes } from '@opentelemetry/resources';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { sanitizeSpanAttributes, sanitizeUrlReferences } from './privacy';

function sanitizeSpan(span: ReadableSpan): ReadableSpan {
  return {
    name: sanitizeUrlReferences(span.name),
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    ended: span.ended,
    status: {
      ...span.status,
      ...(span.status.message ? { message: sanitizeUrlReferences(span.status.message) } : {}),
    },
    attributes: sanitizeSpanAttributes(span.attributes),
    resource: resourceFromAttributes(sanitizeSpanAttributes(span.resource.attributes)),
    instrumentationScope: span.instrumentationScope,
    events: span.events.map((event) => ({
      ...event,
      name: sanitizeUrlReferences(event.name),
      ...(event.attributes ? { attributes: sanitizeSpanAttributes(event.attributes) } : {}),
    })),
    links: span.links.map((link) => ({
      ...link,
      ...(link.attributes ? { attributes: sanitizeSpanAttributes(link.attributes) } : {}),
    })),
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/** Redact at the real exporter boundary; the pinned SDK's attribute callback is not wired by its default exporter. */
export class PrivacyTraceExporter implements SpanExporter {
  constructor(private readonly exporter: SpanExporter) {}

  export(spans: ReadableSpan[], callback: Parameters<SpanExporter['export']>[1]): void {
    this.exporter.export(spans.map(sanitizeSpan), callback);
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.() ?? Promise.resolve();
  }
}

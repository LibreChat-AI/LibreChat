export type TraceContext = {
  traceId: string;
  spanId: string;
};

type SpanContextShape = { traceId?: unknown; spanId?: unknown };
type SpanShape = { spanContext?: () => SpanContextShape };
type ContextShape = { getValue?: (key: symbol) => unknown };
type OtelGlobalShape = { context?: { active?: () => ContextShape } };

/** Registry key and span context key defined by `@opentelemetry/api` 1.x, which the RUM SDK registers. */
const OTEL_API_KEY = Symbol.for('opentelemetry.js.api.1');
const SPAN_KEY = Symbol.for('OpenTelemetry Context Key SPAN');
const TRACE_ID = /^(?!0+$)[0-9a-f]{32}$/;
const SPAN_ID = /^(?!0+$)[0-9a-f]{16}$/;

function isSpan(value: unknown): value is SpanShape {
  return typeof value === 'object' && value !== null && 'spanContext' in value;
}

/**
 * Reads the active trace/span ids from the OpenTelemetry context the RUM SDK registered, without
 * bundling a second copy of the API. Returns `undefined` when no SDK or no span is active.
 */
export function getActiveTraceContext(): TraceContext | undefined {
  try {
    const api: OtelGlobalShape | undefined = Reflect.get(globalThis, OTEL_API_KEY);
    const span = api?.context?.active?.()?.getValue?.(SPAN_KEY);
    if (!isSpan(span) || typeof span.spanContext !== 'function') {
      return undefined;
    }
    const { traceId, spanId } = span.spanContext();
    if (typeof traceId !== 'string' || typeof spanId !== 'string') {
      return undefined;
    }
    return TRACE_ID.test(traceId) && SPAN_ID.test(spanId) ? { traceId, spanId } : undefined;
  } catch {
    return undefined;
  }
}

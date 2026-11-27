import { performance } from 'node:perf_hooks';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Attributes, Span } from '@opentelemetry/api';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

const STREAM_SPAN_NAME = 'librechat.sse.stream';
const STREAM_ROUTE = '/api/agents/chat/stream/:streamId';

type StreamEndReason = 'done' | 'client_aborted' | 'server_error' | 'subscribe_failed';

export interface SseStreamTelemetry {
  recordHeadersFlushed: () => void;
  recordWrite: (payload: string, options?: { final?: boolean }) => void;
  recordFinalEventEmitted: () => void;
  recordErrorEventEmitted: () => void;
  recordSubscribeFailed: () => void;
}

interface SseStreamTelemetryOptions {
  isResume: boolean;
  req: ServerRequest;
  res: Response;
  streamId: string;
}

class SseStreamSpanTelemetry implements SseStreamTelemetry {
  private readonly span: Span;
  private readonly startTimeMs = performance.now();
  private bytesSent = 0;
  private chunksCount = 0;
  private ended = false;
  private errorEventEmitted = false;
  private finalEventEmitted = false;
  private finalEventWritten = false;
  private firstChunkMs: number | undefined;
  private plannedEndReason: StreamEndReason | undefined;

  constructor({ isResume, req, res, streamId }: SseStreamTelemetryOptions) {
    this.span = trace.getTracer('librechat.telemetry').startSpan(
      STREAM_SPAN_NAME,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          'http.request.method': req.method,
          'http.route': STREAM_ROUTE,
          'librechat.stream.id': streamId,
          'librechat.stream.resume': isResume,
          'librechat.stream.route': STREAM_ROUTE,
        },
      },
      context.active(),
    );

    res.once('finish', () => {
      this.end(this.plannedEndReason ?? (this.errorEventEmitted ? 'server_error' : 'done'));
    });

    res.once('close', () => {
      if (res.writableEnded) {
        this.end(this.plannedEndReason ?? (this.errorEventEmitted ? 'server_error' : 'done'));
        return;
      }

      this.span.addEvent('client_aborted');
      this.end('client_aborted');
    });
  }

  recordHeadersFlushed(): void {
    this.span.addEvent('headers_flushed');
    this.span.setAttribute('librechat.stream.headers_flushed', true);
  }

  recordWrite(payload: string, options?: { final?: boolean }): void {
    if (this.ended) {
      return;
    }

    this.chunksCount += 1;
    this.bytesSent += Buffer.byteLength(payload);

    if (this.firstChunkMs === undefined) {
      this.firstChunkMs = performance.now() - this.startTimeMs;
      this.span.addEvent('first_chunk');
      this.span.setAttribute('librechat.stream.time_to_first_chunk_ms', this.firstChunkMs);
    }

    if (options?.final) {
      this.finalEventWritten = true;
      this.span.addEvent('final_event_written');
    }
  }

  recordFinalEventEmitted(): void {
    this.finalEventEmitted = true;
    this.plannedEndReason = 'done';
    this.span.addEvent('final_event_emitted');
  }

  recordErrorEventEmitted(): void {
    this.errorEventEmitted = true;
    this.plannedEndReason ??= 'server_error';
    this.span.addEvent('error_event_emitted');
  }

  recordSubscribeFailed(): void {
    this.plannedEndReason = 'subscribe_failed';
    this.span.addEvent('subscribe_failed');
  }

  private end(reason: StreamEndReason): void {
    if (this.ended) {
      return;
    }

    this.ended = true;
    const attributes: Attributes = {
      'http.response.body.size': this.bytesSent,
      'librechat.stream.bytes.sent': this.bytesSent,
      'librechat.stream.chunks.count': this.chunksCount,
      'librechat.stream.completed': reason === 'done',
      'librechat.stream.duration_ms': performance.now() - this.startTimeMs,
      'librechat.stream.end_reason': reason,
      'librechat.stream.error_event_emitted': this.errorEventEmitted,
      'librechat.stream.final_event_emitted': this.finalEventEmitted,
      'librechat.stream.final_event_written': this.finalEventWritten,
    };

    if (this.firstChunkMs !== undefined) {
      attributes['librechat.stream.time_to_first_chunk_ms'] = this.firstChunkMs;
    }

    this.span.setAttributes(attributes);

    if (reason !== 'done') {
      this.span.setStatus({ code: SpanStatusCode.ERROR });
      this.span.setAttribute('error.type', reason);
    }

    this.span.end();
  }
}

export function createSseStreamTelemetry(options: SseStreamTelemetryOptions): SseStreamTelemetry {
  return new SseStreamSpanTelemetry(options);
}

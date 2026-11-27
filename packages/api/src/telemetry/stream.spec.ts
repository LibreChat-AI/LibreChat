import { EventEmitter } from 'node:events';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Response } from 'express';
import type { Span, Tracer } from '@opentelemetry/api';
import type { ServerRequest } from '~/types';
import { createSseStreamTelemetry } from './stream';

interface MockResponse extends EventEmitter {
  writableEnded: boolean;
}

function createSpan(): jest.Mocked<Span> {
  const span = {} as jest.Mocked<Span>;
  span.addEvent = jest.fn<jest.Mocked<Span>, Parameters<Span['addEvent']>>(() => span);
  span.addLink = jest.fn<jest.Mocked<Span>, Parameters<Span['addLink']>>(() => span);
  span.addLinks = jest.fn<jest.Mocked<Span>, Parameters<Span['addLinks']>>(() => span);
  span.end = jest.fn<void, Parameters<Span['end']>>();
  span.isRecording = jest.fn<boolean, Parameters<Span['isRecording']>>(() => true);
  span.recordException = jest.fn<void, Parameters<Span['recordException']>>();
  span.setAttribute = jest.fn<jest.Mocked<Span>, Parameters<Span['setAttribute']>>(() => span);
  span.setAttributes = jest.fn<jest.Mocked<Span>, Parameters<Span['setAttributes']>>(() => span);
  span.setStatus = jest.fn<jest.Mocked<Span>, Parameters<Span['setStatus']>>(() => span);
  span.spanContext = jest.fn<ReturnType<Span['spanContext']>, Parameters<Span['spanContext']>>(
    () => ({
      spanId: '0000000000000000',
      traceFlags: 0,
      traceId: '00000000000000000000000000000000',
    }),
  );
  span.updateName = jest.fn<jest.Mocked<Span>, Parameters<Span['updateName']>>(() => span);
  return span;
}

function createRequest(): ServerRequest {
  return {
    method: 'GET',
  } as ServerRequest;
}

function createResponse(): MockResponse {
  const res = new EventEmitter() as MockResponse;
  res.writableEnded = false;
  return res;
}

function mockTracer(span: jest.Mocked<Span>): jest.Mock {
  const startSpan = jest.fn(() => span);
  jest.spyOn(trace, 'getTracer').mockReturnValue({ startSpan } as unknown as Tracer);
  return startSpan;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createSseStreamTelemetry', () => {
  it('records normal stream completion attributes', () => {
    const span = createSpan();
    const startSpan = mockTracer(span);
    const res = createResponse();
    const telemetry = createSseStreamTelemetry({
      isResume: false,
      req: createRequest(),
      res: res as Response,
      streamId: 'stream-1',
    });
    const payload = 'event: message\ndata: {"final":true}\n\n';

    telemetry.recordHeadersFlushed();
    telemetry.recordFinalEventEmitted();
    telemetry.recordWrite(payload, { final: true });
    res.writableEnded = true;
    res.emit('finish');

    expect(startSpan).toHaveBeenCalledWith(
      'librechat.sse.stream',
      {
        kind: SpanKind.INTERNAL,
        attributes: expect.objectContaining({
          'http.request.method': 'GET',
          'http.route': '/api/agents/chat/stream/:streamId',
          'librechat.stream.id': 'stream-1',
          'librechat.stream.resume': false,
          'librechat.stream.route': '/api/agents/chat/stream/:streamId',
        }),
      },
      context.active(),
    );
    expect(span.addEvent).toHaveBeenCalledWith('headers_flushed');
    expect(span.addEvent).toHaveBeenCalledWith('first_chunk');
    expect(span.addEvent).toHaveBeenCalledWith('final_event_emitted');
    expect(span.addEvent).toHaveBeenCalledWith('final_event_written');
    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'http.response.body.size': Buffer.byteLength(payload),
        'librechat.stream.bytes.sent': Buffer.byteLength(payload),
        'librechat.stream.chunks.count': 1,
        'librechat.stream.completed': true,
        'librechat.stream.end_reason': 'done',
        'librechat.stream.error_event_emitted': false,
        'librechat.stream.final_event_emitted': true,
        'librechat.stream.final_event_written': true,
        'librechat.stream.time_to_first_chunk_ms': expect.any(Number),
      }),
    );
    expect(span.setStatus).not.toHaveBeenCalled();
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it('records client aborts on close before writableEnded', () => {
    const span = createSpan();
    mockTracer(span);
    const res = createResponse();
    const telemetry = createSseStreamTelemetry({
      isResume: true,
      req: createRequest(),
      res: res as Response,
      streamId: 'stream-2',
    });

    telemetry.recordWrite('event: message\ndata: {}\n\n');
    res.emit('close');

    expect(span.addEvent).toHaveBeenCalledWith('client_aborted');
    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'librechat.stream.completed': false,
        'librechat.stream.end_reason': 'client_aborted',
      }),
    );
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(span.setAttribute).toHaveBeenCalledWith('error.type', 'client_aborted');
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it('preserves subscribe_failed as the terminal reason when an error event is sent', () => {
    const span = createSpan();
    mockTracer(span);
    const res = createResponse();
    const telemetry = createSseStreamTelemetry({
      isResume: false,
      req: createRequest(),
      res: res as Response,
      streamId: 'stream-3',
    });

    telemetry.recordSubscribeFailed();
    telemetry.recordErrorEventEmitted();
    telemetry.recordWrite('event: error\ndata: {"error":"Failed to subscribe to stream"}\n\n');
    res.writableEnded = true;
    res.emit('finish');

    expect(span.addEvent).toHaveBeenCalledWith('subscribe_failed');
    expect(span.addEvent).toHaveBeenCalledWith('error_event_emitted');
    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'librechat.stream.completed': false,
        'librechat.stream.end_reason': 'subscribe_failed',
        'librechat.stream.error_event_emitted': true,
      }),
    );
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(span.setAttribute).toHaveBeenCalledWith('error.type', 'subscribe_failed');
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it('ends only once when finish and close both fire', () => {
    const span = createSpan();
    mockTracer(span);
    const res = createResponse();
    const telemetry = createSseStreamTelemetry({
      isResume: false,
      req: createRequest(),
      res: res as Response,
      streamId: 'stream-4',
    });

    telemetry.recordFinalEventEmitted();
    telemetry.recordWrite('event: message\ndata: {"final":true}\n\n', { final: true });
    res.writableEnded = true;
    res.emit('finish');
    res.emit('close');

    expect(span.end).toHaveBeenCalledTimes(1);
    expect(span.setAttributes).toHaveBeenCalledTimes(1);
  });

  it('does not count writes after the stream span has ended', () => {
    const span = createSpan();
    mockTracer(span);
    const res = createResponse();
    const telemetry = createSseStreamTelemetry({
      isResume: false,
      req: createRequest(),
      res: res as Response,
      streamId: 'stream-5',
    });
    const firstPayload = 'event: message\ndata: {"index":1}\n\n';

    telemetry.recordWrite(firstPayload);
    res.emit('close');
    telemetry.recordWrite('event: message\ndata: {"index":2}\n\n');

    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'librechat.stream.bytes.sent': Buffer.byteLength(firstPayload),
        'librechat.stream.chunks.count': 1,
      }),
    );
    expect(span.end).toHaveBeenCalledTimes(1);
  });
});

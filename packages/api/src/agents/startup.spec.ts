import { EventEmitter } from 'node:events';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span, Tracer } from '@opentelemetry/api';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import {
  acceptAgentStartupTelemetry,
  agentStartupIngressMiddleware,
  agentStartupTelemetryMiddleware,
  createAgentStartupTelemetry,
  getAgentStartupTelemetry,
} from './startup';
import {
  isMetricsConfigured,
  recordAgentStartupMilestone,
  recordAgentStartupResult,
} from '~/app/metrics';

jest.mock('~/app/metrics', () => ({
  isMetricsConfigured: jest.fn(() => true),
  recordAgentStartupMilestone: jest.fn(),
  recordAgentStartupResult: jest.fn(),
}));

interface MockResponse extends EventEmitter {
  statusCode: number;
  locals: Record<PropertyKey, unknown>;
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

function mockTracer(span: jest.Mocked<Span>): jest.Mock {
  const startSpan = jest.fn(() => span);
  jest.spyOn(trace, 'getTracer').mockReturnValue({ startSpan } as unknown as Tracer);
  return startSpan;
}

function createRequest(path = '/'): ServerRequest {
  return {
    method: 'POST',
    path,
  } as ServerRequest;
}

function createResponse(statusCode = 200): MockResponse {
  const res = new EventEmitter() as MockResponse;
  res.statusCode = statusCode;
  res.locals = {};
  return res;
}

afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('createAgentStartupTelemetry', () => {
  it('records cumulative milestones once and ends on the first renderable delta', () => {
    const span = createSpan();
    const startSpan = mockTracer(span);
    let now = 100;
    const telemetry = createAgentStartupTelemetry({ now: () => now })!;

    now = 125;
    telemetry.mark('job_created');
    now = 140;
    telemetry.mark('job_created');
    now = 150;
    telemetry.recordGenerationEvent({ event: 'on_run_step', data: {} });
    now = 165;
    telemetry.recordGenerationEvent({
      event: 'on_message_delta',
      data: { delta: { content: { text: '' } } },
    });
    now = 180;
    telemetry.recordGenerationEvent({
      event: 'on_message_delta',
      data: { delta: { content: [{ text: 'Hello' }] } },
    });
    now = 200;
    telemetry.recordGenerationEvent({
      event: 'on_reasoning_delta',
      data: { delta: { content: { think: 'Already ended' } } },
    });

    expect(startSpan).toHaveBeenCalledWith(
      'librechat.agent.startup',
      { kind: SpanKind.INTERNAL },
      context.active(),
    );
    expect(span.addEvent).toHaveBeenNthCalledWith(1, 'job_created', {
      'librechat.agent.startup.elapsed_ms': 25,
    });
    expect(span.addEvent).toHaveBeenNthCalledWith(2, 'first_response_event_queued', {
      'librechat.agent.startup.elapsed_ms': 50,
    });
    expect(span.addEvent).toHaveBeenNthCalledWith(3, 'first_content_delta_queued', {
      'librechat.agent.startup.elapsed_ms': 80,
    });
    expect(recordAgentStartupMilestone).toHaveBeenCalledTimes(3);
    expect(recordAgentStartupMilestone).toHaveBeenNthCalledWith(1, 'job_created', 0.025);
    expect(recordAgentStartupMilestone).toHaveBeenNthCalledWith(
      2,
      'first_response_event_queued',
      0.05,
    );
    expect(recordAgentStartupMilestone).toHaveBeenNthCalledWith(
      3,
      'first_content_delta_queued',
      0.08,
    );
    expect(recordAgentStartupResult).toHaveBeenCalledWith('content_queued');
    expect(span.setAttributes).toHaveBeenCalledWith({
      'librechat.agent.startup.duration_ms': 80,
      'librechat.agent.startup.milestones.count': 3,
      'librechat.agent.startup.result': 'content_queued',
    });
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it('records terminal errors once', () => {
    const span = createSpan();
    mockTracer(span);
    let now = 10;
    const telemetry = createAgentStartupTelemetry({ now: () => now })!;
    const error = new TypeError('startup failed: sk-secret-canary');

    now = 25;
    telemetry.end('error', error);
    now = 30;
    telemetry.end('aborted');
    telemetry.mark('client_initialized');

    expect(span.recordException).toHaveBeenCalledWith({
      message: 'Error details withheld',
      name: 'TypeError',
    });
    expect(JSON.stringify(span.recordException.mock.calls)).not.toContain('sk-secret-canary');
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(recordAgentStartupResult).toHaveBeenCalledTimes(1);
    expect(recordAgentStartupResult).toHaveBeenCalledWith('error');
    expect(span.end).toHaveBeenCalledTimes(1);
    expect(span.addEvent).not.toHaveBeenCalled();
  });

  it('drops untyped milestones and normalizes untyped terminal results', () => {
    const span = createSpan();
    mockTracer(span);
    const telemetry = createAgentStartupTelemetry({ now: () => 10 })!;

    Reflect.apply(telemetry.mark, undefined, ['unbounded-user-value']);
    telemetry.mark('job_created');
    Reflect.apply(telemetry.end, undefined, ['unbounded-user-value']);

    expect(span.addEvent).toHaveBeenCalledTimes(1);
    expect(span.addEvent).toHaveBeenCalledWith('job_created', expect.any(Object));
    expect(recordAgentStartupResult).toHaveBeenCalledWith('error');
    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'librechat.agent.startup.milestones.count': 1,
        'librechat.agent.startup.result': 'error',
      }),
    );
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it('returns no recorder when tracing and metrics are disabled', () => {
    const span = createSpan();
    span.isRecording.mockReturnValue(false);
    jest.mocked(isMetricsConfigured).mockReturnValueOnce(false);
    mockTracer(span);

    const telemetry = createAgentStartupTelemetry();

    expect(telemetry).toBeUndefined();
    expect(recordAgentStartupMilestone).not.toHaveBeenCalled();
    expect(recordAgentStartupResult).not.toHaveBeenCalled();
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it('skips span work when only metrics are enabled', () => {
    const span = createSpan();
    span.isRecording.mockReturnValue(false);
    mockTracer(span);
    const telemetry = createAgentStartupTelemetry({ now: () => 10 })!;

    telemetry.mark('job_created');
    telemetry.end('content_queued');

    expect(recordAgentStartupMilestone).toHaveBeenCalledWith('job_created', 0);
    expect(recordAgentStartupResult).toHaveBeenCalledWith('content_queued');
    expect(span.addEvent).not.toHaveBeenCalled();
    expect(span.setAttributes).not.toHaveBeenCalled();
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it('skips metric work when only tracing is enabled', () => {
    const span = createSpan();
    jest.mocked(isMetricsConfigured).mockReturnValueOnce(false);
    mockTracer(span);
    const telemetry = createAgentStartupTelemetry({ now: () => 10 })!;

    telemetry.mark('job_created');
    telemetry.end('content_queued');

    expect(span.addEvent).toHaveBeenCalledWith('job_created', expect.any(Object));
    expect(span.setAttributes).toHaveBeenCalled();
    expect(recordAgentStartupMilestone).not.toHaveBeenCalled();
    expect(recordAgentStartupResult).not.toHaveBeenCalled();
    expect(span.end).toHaveBeenCalledTimes(1);
  });
});

describe('agentStartupTelemetryMiddleware', () => {
  it('carries the outer ingress timestamp into the recorder', () => {
    const span = createSpan();
    const startSpan = mockTracer(span);
    const req = createRequest();
    const res = createResponse();
    const next = jest.fn();
    jest.spyOn(Date, 'now').mockReturnValue(1_750_000_000_000);

    agentStartupIngressMiddleware(req, res as Response, next);
    agentStartupTelemetryMiddleware(req, res as Response, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(getAgentStartupTelemetry(req)).toBeDefined();
    expect(startSpan).toHaveBeenCalledWith(
      'librechat.agent.startup',
      {
        kind: SpanKind.INTERNAL,
        startTime: 1_750_000_000_000,
      },
      context.active(),
    );
  });

  it('records the ACK without ending an accepted startup', () => {
    const span = createSpan();
    mockTracer(span);
    const req = createRequest();
    const res = createResponse();
    const next = jest.fn();

    agentStartupTelemetryMiddleware(req, res as Response, next);
    const telemetry = getAgentStartupTelemetry(req);
    acceptAgentStartupTelemetry(req, 'stream-123');
    res.emit('finish');
    res.emit('close');

    expect(next).toHaveBeenCalledTimes(1);
    expect(telemetry).toBeDefined();
    expect(span.setAttribute).toHaveBeenCalledWith('librechat.stream.id', 'stream-123');
    expect(recordAgentStartupMilestone).toHaveBeenCalledWith('ack_sent', expect.any(Number));
    expect(recordAgentStartupResult).not.toHaveBeenCalled();
    expect(span.end).not.toHaveBeenCalled();
  });

  it('finalizes requests rejected before job creation', () => {
    const span = createSpan();
    mockTracer(span);
    const req = createRequest();
    const res = createResponse(403);
    const next = jest.fn();

    agentStartupTelemetryMiddleware(req, res as Response, next);
    res.emit('finish');
    res.emit('close');

    expect(recordAgentStartupResult).toHaveBeenCalledTimes(1);
    expect(recordAgentStartupResult).toHaveBeenCalledWith('rejected');
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it('skips resume requests', () => {
    const span = createSpan();
    mockTracer(span);
    const req = createRequest('/resume');
    const res = createResponse();
    const next = jest.fn();

    agentStartupTelemetryMiddleware(req, res as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(getAgentStartupTelemetry(req)).toBeUndefined();
    expect(trace.getTracer).not.toHaveBeenCalled();
  });

  it('does not retain listeners or request state when telemetry is disabled', () => {
    const span = createSpan();
    span.isRecording.mockReturnValue(false);
    jest.mocked(isMetricsConfigured).mockReturnValueOnce(false);
    mockTracer(span);
    const req = createRequest();
    const res = createResponse();
    const next = jest.fn();

    agentStartupTelemetryMiddleware(req, res as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(getAgentStartupTelemetry(req)).toBeUndefined();
    expect(res.listenerCount('finish')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });
});

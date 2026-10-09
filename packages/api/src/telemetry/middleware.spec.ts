import { EventEmitter } from 'node:events';
import { CacheKeys } from 'librechat-data-provider';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { NextFunction, Response } from 'express';
import type { Span } from '@opentelemetry/api';
import type { ServerRequest } from '~/types';
import { telemetryErrorMiddleware, telemetryMiddleware } from './middleware';
import { observeRedisOperation } from '~/cache/redisTelemetry';
import { getTelemetryRequestSpan } from './sdk';

jest.mock('./sdk', () => ({
  getTelemetryRequestSpan: jest.fn(),
}));

const mockGetTelemetryRequestSpan = getTelemetryRequestSpan as jest.MockedFunction<
  typeof getTelemetryRequestSpan
>;

interface MockResponse extends EventEmitter {
  statusCode: number;
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

function createResponse(statusCode = 200): MockResponse {
  const res = new EventEmitter() as MockResponse;
  res.statusCode = statusCode;
  res.writableEnded = false;
  return res;
}

function createRequest(overrides: Partial<ServerRequest> = {}): ServerRequest {
  return {
    baseUrl: '/api/messages',
    body: {
      prompt: 'do not capture this prompt',
      text: 'do not capture this body',
    },
    headers: {
      authorization: 'Bearer do-not-capture-this-auth-header',
      cookie: 'session=do-not-capture-this-cookie',
      'x-api-key': 'do-not-capture-this-api-key',
    },
    method: 'POST',
    path: '/api/messages/conversation-1',
    route: { path: '/:conversationId' },
    user: {
      email: 'do-not-capture@example.com',
      id: 'user-1',
      tenantId: 'tenant-1',
    } as ServerRequest['user'],
    ...overrides,
  } as ServerRequest;
}

afterEach(() => {
  mockGetTelemetryRequestSpan.mockReset();
});

describe('telemetryMiddleware', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes through without an active span', () => {
    const next = jest.fn();
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);

    telemetryMiddleware(createRequest(), createResponse() as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('uses the stored request span for deferred completion attributes', () => {
    const activeSpan = createSpan();
    const requestSpan = createSpan();
    const req = createRequest();
    const res = createResponse(202);
    const next: NextFunction = jest.fn();
    mockGetTelemetryRequestSpan.mockReturnValue(requestSpan);
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(activeSpan);

    telemetryMiddleware(req, res as Response, next);
    res.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    expect(trace.getActiveSpan).not.toHaveBeenCalled();
    expect(activeSpan.setAttributes).not.toHaveBeenCalled();
    expect(requestSpan.setAttributes).toHaveBeenCalledWith({
      'http.request.method': 'POST',
    });
    expect(requestSpan.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'http.response.status_code': 202,
        'http.route': '/api/messages/:conversationId',
      }),
    );
  });

  it('adds aggregated Redis activity to the stored request span', async () => {
    const requestSpan = createSpan();
    const res = createResponse(200);
    let operation: Promise<string> | undefined;
    mockGetTelemetryRequestSpan.mockReturnValue(requestSpan);

    telemetryMiddleware(createRequest(), res as Response, () => {
      operation = observeRedisOperation('keyv', CacheKeys.AUTH_USER_DOC, 'get', async () =>
        Promise.resolve('cached-user'),
      );
    });
    await operation;
    res.emit('finish');

    const attributes = Object.assign(
      {},
      ...requestSpan.setAttributes.mock.calls.map(([value]) => value),
    );
    expect(attributes).toMatchObject({
      'librechat.redis.calls': 1,
      'librechat.redis.errors': 0,
      'librechat.redis.operations': ['get'],
      'librechat.redis.use_cases': ['auth_user_doc'],
      'librechat.redis.auth_user_doc.calls': 1,
    });
  });

  it('records safe route and identity attributes without body content', () => {
    const span = createSpan();
    const req = createRequest();
    const res = createResponse(201);
    const next: NextFunction = jest.fn();
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(span);

    telemetryMiddleware(req, res as Response, next);
    res.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    expect(span.setAttributes).toHaveBeenCalledWith({
      'http.request.method': 'POST',
    });
    expect(span.setAttributes).toHaveBeenCalledWith({
      'enduser.id': 'user-1',
      'librechat.tenant.id': 'tenant-1',
    });
    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'http.response.status_code': 201,
        'http.route': '/api/messages/:conversationId',
      }),
    );

    const capturedAttributes = JSON.stringify(span.setAttributes.mock.calls);
    expect(capturedAttributes).not.toContain('do not capture this prompt');
    expect(capturedAttributes).not.toContain('do not capture this body');
    expect(capturedAttributes).not.toContain('do-not-capture@example.com');
    expect(capturedAttributes).not.toContain('conversation-1');
    expect(capturedAttributes).not.toContain('do-not-capture-this-auth-header');
    expect(capturedAttributes).not.toContain('do-not-capture-this-cookie');
    expect(capturedAttributes).not.toContain('do-not-capture-this-api-key');
  });

  it('records identity attributes populated by downstream middleware', () => {
    const span = createSpan();
    const req = createRequest({
      headers: {},
      user: undefined,
    });
    const res = createResponse(200);
    const next: NextFunction = jest.fn(() => {
      req.user = {
        id: 'late-user',
        tenantId: 'late-tenant',
      } as ServerRequest['user'];
    });
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(span);

    telemetryMiddleware(req, res as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(span.setAttributes).toHaveBeenCalledTimes(1);

    res.emit('finish');

    expect(span.setAttributes).toHaveBeenCalledWith({
      'enduser.id': 'late-user',
      'librechat.tenant.id': 'late-tenant',
    });
  });

  it('does not derive tenant identity from request headers', () => {
    const span = createSpan();
    const req = createRequest({
      headers: {
        'x-tenant-id': 'spoofed-tenant',
      },
      user: undefined,
    });
    const res = createResponse(200);
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(span);

    telemetryMiddleware(req, res as Response, jest.fn());
    res.emit('finish');

    expect(span.setAttributes).not.toHaveBeenCalledWith(
      expect.objectContaining({
        'librechat.tenant.id': 'spoofed-tenant',
      }),
    );
    expect(JSON.stringify(span.setAttributes.mock.calls)).not.toContain('spoofed-tenant');
  });

  it('ignores health checks', () => {
    const span = createSpan();
    const next = jest.fn();
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(span);

    telemetryMiddleware(
      createRequest({
        baseUrl: '',
        path: '/health',
        route: undefined,
      }),
      createResponse() as Response,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(span.setAttributes).not.toHaveBeenCalled();
  });

  it('uses a low-cardinality fallback for unmatched API routes', () => {
    const span = createSpan();
    const req = createRequest({
      baseUrl: '',
      path: '/api/nonexistent/123',
      route: undefined,
    });
    const res = createResponse(404);
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(span);

    telemetryMiddleware(req, res as Response, jest.fn());
    res.emit('finish');

    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'http.route': '/api/*',
        'http.response.status_code': 404,
      }),
    );
  });

  it('uses a low-cardinality fallback for unmatched SPA routes', () => {
    const span = createSpan();
    const req = createRequest({
      baseUrl: '',
      path: '/chat/conversation-id',
      route: undefined,
    });
    const res = createResponse(200);
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(span);

    telemetryMiddleware(req, res as Response, jest.fn());
    res.emit('finish');

    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'http.route': 'spa_fallback',
        'http.response.status_code': 200,
      }),
    );
  });

  it('marks server responses as errored', () => {
    const span = createSpan();
    const req = createRequest();
    const res = createResponse(500);
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(span);

    telemetryMiddleware(req, res as Response, jest.fn());
    res.emit('finish');

    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
  });

  it('records completion attributes only once when finish and close both fire', () => {
    const span = createSpan();
    const res = createResponse(200);
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(span);

    telemetryMiddleware(createRequest(), res as Response, jest.fn());
    res.emit('finish');
    res.emit('close');

    expect(span.setAttributes).toHaveBeenCalledTimes(3);
  });

  it('marks client disconnects before finish as aborted errors', () => {
    const span = createSpan();
    const res = createResponse(200);
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(span);

    telemetryMiddleware(createRequest(), res as Response, jest.fn());
    res.emit('close');

    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'http.response.status_code': 499,
        'librechat.request.aborted': true,
      }),
    );
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
  });
});

describe('telemetryErrorMiddleware', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('records safe exception metadata and forwards the original error', () => {
    const span = createSpan();
    const error = new TypeError('Bearer exception-token-canary');
    error.name = 'refresh_token=error-name-canary';
    Object.defineProperty(error, 'constructor', {
      value: { name: 'client_secret=constructor-canary' },
    });
    const next = jest.fn();
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(span);

    telemetryErrorMiddleware(error, createRequest(), createResponse() as Response, next);

    expect(span.recordException).toHaveBeenCalledWith({
      message: 'Error details withheld',
      name: 'TypeError',
    });
    expect(JSON.stringify(span.recordException.mock.calls)).not.toContain('exception-token-canary');
    expect(JSON.stringify(span.recordException.mock.calls)).not.toContain('error-name-canary');
    expect(JSON.stringify(span.recordException.mock.calls)).not.toContain('constructor-canary');
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(span.setAttributes).toHaveBeenCalledWith({
      'enduser.id': 'user-1',
      'librechat.tenant.id': 'tenant-1',
    });
    expect(span.setAttributes).toHaveBeenCalledWith({
      'error.type': 'TypeError',
      'http.route': '/api/messages/:conversationId',
    });
    expect(next).toHaveBeenCalledWith(error);
  });

  it('falls back to Error for untrusted custom error prototypes', () => {
    const span = createSpan();
    const SecretNamedError = class refresh_token_supersecret extends Error {};
    const error = new SecretNamedError('client_secret=message-canary');
    const next = jest.fn();
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(span);

    telemetryErrorMiddleware(error, createRequest(), createResponse() as Response, next);

    expect(span.recordException).toHaveBeenCalledWith({
      message: 'Error details withheld',
      name: 'Error',
    });
    expect(JSON.stringify(span.recordException.mock.calls)).not.toContain('supersecret');
    expect(JSON.stringify(span.recordException.mock.calls)).not.toContain('message-canary');
    expect(next).toHaveBeenCalledWith(error);
  });

  it('records exceptions on the stored request span when available', () => {
    const activeSpan = createSpan();
    const requestSpan = createSpan();
    const error = new TypeError('boom');
    const next = jest.fn();
    mockGetTelemetryRequestSpan.mockReturnValue(requestSpan);
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(activeSpan);

    telemetryErrorMiddleware(error, createRequest(), createResponse() as Response, next);

    expect(trace.getActiveSpan).not.toHaveBeenCalled();
    expect(activeSpan.recordException).not.toHaveBeenCalled();
    expect(requestSpan.recordException).toHaveBeenCalledWith({
      message: 'Error details withheld',
      name: 'TypeError',
    });
    expect(requestSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(next).toHaveBeenCalledWith(error);
  });

  it('handles non-Error values without throwing', () => {
    const span = createSpan();
    const next = jest.fn();
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(span);

    telemetryErrorMiddleware(
      'refresh_token=non-error-token-canary',
      createRequest(),
      createResponse() as Response,
      next,
    );

    expect(span.recordException).toHaveBeenCalledWith({
      message: 'Error details withheld',
      name: 'string',
    });
    expect(JSON.stringify(span.recordException.mock.calls)).not.toContain('non-error-token-canary');
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'error.type': 'string',
        'http.route': '/api/messages/:conversationId',
      }),
    );
    expect(next).toHaveBeenCalledWith('refresh_token=non-error-token-canary');
  });

  it('handles null error values without throwing', () => {
    const span = createSpan();
    const next = jest.fn();
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(span);

    telemetryErrorMiddleware(null, createRequest(), createResponse() as Response, next);

    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(span.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'error.type': 'null',
        'http.route': '/api/messages/:conversationId',
      }),
    );
    expect(next).toHaveBeenCalledWith(null);
  });

  it('forwards the error without an active span', () => {
    const error = new Error('boom');
    const next = jest.fn();
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);

    telemetryErrorMiddleware(error, createRequest(), createResponse() as Response, next);

    expect(next).toHaveBeenCalledWith(error);
  });
});

import express from 'express';
import request from 'supertest';
import { logger, tenantStorage } from '@librechat/data-schemas';
import type { ServerProductEvent, ServerProductFact } from 'librechat-data-provider';
import type { RequestHandler, Response } from 'express';
import type { ServerProductSink } from './request';
import type { ServerRequest } from '~/types';
import {
  trackRequestProductFact,
  bindProductSubmissionContext,
  createProductTrackingMiddleware,
} from './request';

const productTracking = { enabled: true };

const fact: ServerProductFact = {
  name: 'librechat.langfuse.connection.updated',
  enabled: true,
  configured: true,
};

it('passes the fact to the request-owned tracker once', () => {
  const productTracker = jest.fn();
  trackRequestProductFact({ productTracker, productTracking }, fact);
  expect(productTracker.mock.calls).toEqual([[fact]]);
});

it('does nothing without a host tracker', () => {
  expect(() => trackRequestProductFact({ productTracking }, fact)).not.toThrow();
});

it('isolates sync and async tracker failures', async () => {
  expect(() =>
    trackRequestProductFact(
      {
        productTracking,
        productTracker: () => {
          throw new Error('offline');
        },
      },
      fact,
    ),
  ).not.toThrow();
  trackRequestProductFact(
    { productTracking, productTracker: () => Promise.reject(new Error('offline')) },
    fact,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
});

it.each([undefined, { enabled: false }])(
  'does not invoke an injected callback when policy is %p',
  (policy) => {
    const productTracker = jest.fn();
    trackRequestProductFact({ productTracker, productTracking: policy }, fact);
    expect(productTracker).not.toHaveBeenCalled();
  },
);

const sessionId = 'd79706cc-4ddf-4cf7-b99a-333755af9be8';
const submissionId = '1b7ff690-8b9b-4af6-b68d-9cab4a5f2f21';

type Scope = { token: string };

function createSink(scope: Scope = { token: 'host-token' }) {
  const delivered: [ServerProductEvent, Scope][] = [];
  const sink: ServerProductSink<Scope> = {
    resolveScope: jest.fn(() => scope),
    deliver: jest.fn((event: ServerProductEvent, resolved: Scope) => {
      delivered.push([event, resolved]);
    }),
  };
  return { sink, delivered };
}

function runMiddleware(
  req: Partial<ServerRequest>,
  enabled: boolean | undefined,
  sink?: ServerProductSink<Scope>,
  browserSink?: Record<string, string | number | boolean>,
) {
  const next = jest.fn();
  createProductTrackingMiddleware(
    enabled === undefined ? undefined : { productTracking: { enabled } },
    { sink, browserSink },
  )(req as ServerRequest, {} as Response, next);
  return next;
}

const signedIn = { id: 'user-1', tenantId: 'tenant-1' } as ServerRequest['user'];

it.each([
  [undefined, true, false],
  [false, true, false],
  [true, false, false],
  [true, true, true],
])(
  'enables tracking for telemetry %p with a sink %p only when both are set',
  (enabled, withSink, expected) => {
    const { sink, delivered } = createSink();
    const req: Partial<ServerRequest> = { user: signedIn };
    const next = runMiddleware(req, enabled, withSink ? sink : undefined);
    trackRequestProductFact(req, fact);
    expect(req.productTracking).toMatchObject({ enabled: expected });
    expect(next).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(expected ? 1 : 0);
  },
);

it('builds the event envelope, with identity from the authenticated request', () => {
  const { sink, delivered } = createSink();
  const req: Partial<ServerRequest> = {};
  runMiddleware(req, true, sink);
  expect(sink.resolveScope).not.toHaveBeenCalled();
  req.user = signedIn;
  trackRequestProductFact(req, fact);
  expect(sink.resolveScope).toHaveBeenCalledWith(req);
  expect(delivered).toEqual([
    [
      {
        version: 1,
        eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        occurredAt: expect.any(String),
        producer: 'server',
        identity: { userId: 'user-1', tenantId: 'tenant-1' },
        fact,
      },
      { token: 'host-token' },
    ],
  ]);
});

it('takes the tenant from the request tenant context before the stored user tenant', () => {
  const { sink, delivered } = createSink();
  const req: Partial<ServerRequest> = { user: signedIn };
  runMiddleware(req, true, sink);
  tenantStorage.run({ tenantId: 'tenant-2' }, () => trackRequestProductFact(req, fact));
  expect(delivered[0][0].identity).toEqual({ userId: 'user-1', tenantId: 'tenant-2' });
});

it('delivers nothing when the sink resolves no scope', () => {
  const sink: ServerProductSink<Scope> = { resolveScope: jest.fn(), deliver: jest.fn() };
  const req: Partial<ServerRequest> = { user: signedIn };
  runMiddleware(req, true, sink);
  trackRequestProductFact(req, fact);
  expect(sink.resolveScope).toHaveBeenCalledTimes(1);
  expect(sink.deliver).not.toHaveBeenCalled();
});

it('contains a sink that throws or rejects', async () => {
  const req: Partial<ServerRequest> = { user: signedIn };
  runMiddleware(req, true, {
    resolveScope: () => {
      throw new Error('no identity');
    },
    deliver: jest.fn(),
  });
  expect(() => trackRequestProductFact(req, fact)).not.toThrow();
  const rejecting: Partial<ServerRequest> = { user: signedIn };
  runMiddleware(rejecting, true, {
    resolveScope: () => ({ token: 'host-token' }),
    deliver: () => Promise.reject(new Error('offline')),
  });
  expect(() => trackRequestProductFact(rejecting, fact)).not.toThrow();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

it('publishes the browser sink settings only while tracking is enabled', () => {
  const browserSink = { destination: 'https://events.example.com', flushIntervalMs: 5000 };
  const enabled: Partial<ServerRequest> = {};
  runMiddleware(enabled, true, createSink().sink, browserSink);
  expect(enabled.productTracking?.browserSink).toEqual(browserSink);
  expect(Object.isFrozen(enabled.productTracking?.browserSink)).toBe(true);
  const disabled: Partial<ServerRequest> = {};
  runMiddleware(disabled, false, createSink().sink, browserSink);
  expect(disabled.productTracking).not.toHaveProperty('browserSink');
});

it('copies valid correlation IDs but never identity from headers', () => {
  const { sink, delivered } = createSink();
  const req: Partial<ServerRequest> = {
    headers: {
      'x-librechat-product-session-id': sessionId,
      'x-librechat-product-submission-id': submissionId,
      'x-librechat-product-user-id': 'untrusted',
    },
  };
  runMiddleware(req, true, sink);
  expect(req.productTrackingContext).toEqual({ sessionId, submissionId });
  expect(req.user).toBeUndefined();
  trackRequestProductFact(req, fact);
  expect(delivered[0][0]).toMatchObject({ identity: {}, context: { sessionId, submissionId } });
});

it.each([
  [{ 'x-librechat-product-submission-id': 'not-a-uuid' }, { sessionId }],
  [{ 'x-librechat-product-submission-id': ['not', 'one'] }, { sessionId }],
  [{ 'x-librechat-product-session-id': 'not-a-uuid' }, { submissionId }],
])('keeps a valid correlation ID when the other header is malformed (%p)', (bad, expected) => {
  const req: Partial<ServerRequest> = {
    headers: {
      'x-librechat-product-session-id': sessionId,
      'x-librechat-product-submission-id': submissionId,
      ...bad,
    },
  };
  runMiddleware(req, true, createSink().sink);
  expect(req.productTrackingContext).toEqual(expected);
});

it.each([false, true])('ignores malformed correlation headers with enabled=%s', (enabled) => {
  const req: Partial<ServerRequest> = {
    headers: { 'x-librechat-product-session-id': ['not', 'one'] },
  };
  runMiddleware(req, enabled, createSink().sink);
  expect(req.productTrackingContext).toBeUndefined();
});

it('delivers a fact from a real Express route after authentication', async () => {
  const { sink, delivered } = createSink();
  const app = express();
  app.use(
    createProductTrackingMiddleware(
      { productTracking: { enabled: true } },
      { sink },
    ) as unknown as RequestHandler,
  );
  app.use((req, _res, next) => {
    (req as ServerRequest).user = signedIn;
    next();
  });
  app.post('/api/settings', (req, res) => {
    trackRequestProductFact(req as ServerRequest, fact);
    res.status(204).end();
  });
  await request(app)
    .post('/api/settings')
    .set('x-librechat-product-session-id', sessionId)
    .set('x-librechat-product-submission-id', 'not-a-uuid')
    .expect(204);
  expect(delivered).toEqual([
    [
      expect.objectContaining({
        identity: { userId: 'user-1', tenantId: 'tenant-1' },
        context: { sessionId },
        fact,
      }),
      { token: 'host-token' },
    ],
  ]);
});

it('joins drained queued turns by UUID without inventing a session', () => {
  const submissionId = '1b7ff690-8b9b-4af6-b68d-9cab4a5f2f21';
  const req: Partial<ServerRequest> = { productTracking };
  bindProductSubmissionContext(req, submissionId);
  expect(req.productTrackingContext).toEqual({ submissionId });
});

it.each([undefined, 'steer-leftover:existing'])('ignores non-UUID queued id %p', (id) => {
  const req: Partial<ServerRequest> = { productTracking };
  bindProductSubmissionContext(req, id);
  expect(req.productTrackingContext).toBeUndefined();
});

it('keeps the original session and explicit submission header', () => {
  const sessionId = 'd79706cc-4ddf-4cf7-b99a-333755af9be8';
  const submissionId = '1b7ff690-8b9b-4af6-b68d-9cab4a5f2f21';
  const req: Partial<ServerRequest> = {
    productTracking,
    productTrackingContext: { sessionId },
  };
  bindProductSubmissionContext(req, submissionId);
  expect(req.productTrackingContext).toEqual({ sessionId, submissionId });
  bindProductSubmissionContext(req, '2b7ff690-8b9b-4af6-b68d-9cab4a5f2f21');
  expect(req.productTrackingContext).toEqual({ sessionId, submissionId });
});

it('ignores queued correlation when tracking is disabled', () => {
  const req: Partial<ServerRequest> = { productTracking: { enabled: false } };
  bindProductSubmissionContext(req, '1b7ff690-8b9b-4af6-b68d-9cab4a5f2f21');
  expect(req.productTrackingContext).toBeUndefined();
});

it('drops malformed facts and contains validation exceptions before host delivery', () => {
  const productTracker = jest.fn();
  const malformed = { ...fact, arguments: 'private' };
  expect(() =>
    trackRequestProductFact({ productTracker, productTracking }, malformed),
  ).not.toThrow();
  const throwing = Object.defineProperty({ ...fact }, 'name', {
    get: () => {
      throw new Error('malformed');
    },
  });
  expect(() =>
    trackRequestProductFact({ productTracker, productTracking }, throwing),
  ).not.toThrow();
  expect(productTracker).not.toHaveBeenCalled();
});

it('logs the name and failing paths of a dropped fact, without its values', () => {
  const debug = jest.spyOn(logger, 'debug').mockImplementation(() => logger);
  trackRequestProductFact({ productTracker: jest.fn(), productTracking }, {
    ...fact,
    enabled: 'private-value',
  } as unknown as ServerProductFact);
  expect(debug).toHaveBeenCalledWith(expect.stringContaining('Dropped a fact'), {
    name: fact.name,
    issues: [{ code: 'invalid_type', path: 'enabled' }],
  });
  expect(JSON.stringify(debug.mock.calls)).not.toContain('private-value');
  debug.mockRestore();
});

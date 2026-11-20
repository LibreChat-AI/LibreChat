import express from 'express';
import request from 'supertest';
import { logger } from '@librechat/data-schemas';
import type { ServerProductFact } from 'librechat-data-provider';
import type { RequestHandler, Response } from 'express';
import type { ProductTrackerFactory } from './request';
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

function runMiddleware(
  req: Partial<ServerRequest>,
  enabled: boolean | undefined,
  createTracker?: ProductTrackerFactory,
) {
  const next = jest.fn();
  createProductTrackingMiddleware(
    enabled === undefined ? undefined : { productTracking: { enabled } },
    { createTracker },
  )(req as ServerRequest, {} as Response, next);
  return next;
}

it.each([
  [undefined, true, false],
  [false, true, false],
  [true, false, false],
  [true, true, true],
])(
  'enables tracking for telemetry %p with a factory %p only when both are set',
  (enabled, withFactory, expected) => {
    const productTracker = jest.fn();
    const req: Partial<ServerRequest> = {};
    const next = runMiddleware(req, enabled, withFactory ? () => productTracker : undefined);
    trackRequestProductFact(req, fact);
    expect(req.productTracking).toMatchObject({ enabled: expected });
    expect(next).toHaveBeenCalledTimes(1);
    expect(productTracker).toHaveBeenCalledTimes(expected ? 1 : 0);
  },
);

it('creates the tracker when a fact is tracked, after authentication sets the user', () => {
  const productTracker = jest.fn();
  const createTracker = jest.fn((req: ServerRequest) => {
    expect(req.user?.id).toBe('user-1');
    return productTracker;
  });
  const req: Partial<ServerRequest> = {};
  runMiddleware(req, true, createTracker);
  expect(createTracker).not.toHaveBeenCalled();
  req.user = { id: 'user-1' } as ServerRequest['user'];
  trackRequestProductFact(req, fact);
  expect(createTracker).toHaveBeenCalledWith(req);
  expect(productTracker.mock.calls).toEqual([[fact]]);
});

it('contains a factory that throws', () => {
  const req: Partial<ServerRequest> = {};
  runMiddleware(req, true, () => {
    throw new Error('no identity');
  });
  expect(() => trackRequestProductFact(req, fact)).not.toThrow();
});

it('copies valid correlation IDs but never identity from headers', () => {
  const productTracker = jest.fn();
  const req: Partial<ServerRequest> = {
    headers: {
      'x-librechat-product-session-id': sessionId,
      'x-librechat-product-submission-id': submissionId,
      'x-librechat-product-user-id': 'untrusted',
    },
  };
  runMiddleware(req, true, () => productTracker);
  expect(req.productTrackingContext).toEqual({ sessionId, submissionId });
  expect(req.user).toBeUndefined();
  trackRequestProductFact(req, fact);
  expect(productTracker).toHaveBeenCalledWith(fact, { sessionId, submissionId });
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
  runMiddleware(req, true, () => jest.fn());
  expect(req.productTrackingContext).toEqual(expected);
});

it.each([false, true])('ignores malformed correlation headers with enabled=%s', (enabled) => {
  const req: Partial<ServerRequest> = {
    headers: { 'x-librechat-product-session-id': ['not', 'one'] },
  };
  runMiddleware(req, enabled, () => jest.fn());
  expect(req.productTrackingContext).toBeUndefined();
});

it('delivers a fact from a real Express route after authentication', async () => {
  const delivered: unknown[] = [];
  const app = express();
  app.use(
    createProductTrackingMiddleware(
      { productTracking: { enabled: true } },
      {
        createTracker: (req) => (event, context) => {
          delivered.push({ userId: req.user?.id, event, context });
        },
      },
    ) as unknown as RequestHandler,
  );
  app.use((req, _res, next) => {
    (req as ServerRequest).user = { id: 'user-1' } as ServerRequest['user'];
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
  expect(delivered).toEqual([{ userId: 'user-1', event: fact, context: { sessionId } }]);
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

it('normalizes private chat labels before invoking an OSS host tracker', () => {
  const productTracker = jest.fn();
  trackRequestProductFact(
    { productTracker, productTracking },
    {
      name: 'librechat.chat.model.usage.recorded',
      feature: 'chat',
      callId: 'call',
      runId: 'run',
      agentId: 'private-endpoint__model___Sender',
      model: 'private-model',
      provider: 'private-provider',
      outcome: 'completed',
    },
  );
  expect(productTracker).toHaveBeenCalledTimes(1);
  expect(productTracker.mock.calls[0][0]).toMatchObject({
    callId: 'call',
    runId: 'run',
    model: 'custom',
    provider: 'custom',
    agentId: undefined,
  });
  expect(JSON.stringify(productTracker.mock.calls)).not.toContain('private');
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

import type { ServerProductFact } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { trackRequestProductFact, createProductTrackingMiddleware } from './request';

const productTracking = { enabled: true };

const fact: ServerProductFact = {
  name: 'librechat.langfuse.connection.changed',
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

it.each([undefined, false, true])(
  'uses the deployment startup policy %p on every request',
  (enabled) => {
    const middleware = createProductTrackingMiddleware(
      enabled === undefined ? undefined : { productTracking: { enabled } },
    );
    const productTracker = jest.fn();
    const req: Partial<ServerRequest> = { productTracker };
    const next = jest.fn();
    middleware(req as ServerRequest, {} as Response, next);
    trackRequestProductFact(req, fact);
    expect(req.productTracking).toEqual({ enabled: enabled === true });
    expect(next).toHaveBeenCalledTimes(1);
    expect(productTracker).toHaveBeenCalledTimes(enabled === true ? 1 : 0);
  },
);

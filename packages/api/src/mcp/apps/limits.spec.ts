import { MemoryStore } from 'express-rate-limit';
import type { NextFunction, Request, Response } from 'express';
import { createMCPAppAdmissionRateLimiter, createMCPAppRateLimiter } from './limits';

type LimitOverrides = {
  resourcesPerMinute?: number;
  toolCallsPerMinute?: number;
};

type Invocation = {
  status: number;
  body?: unknown;
  headers: Record<string, string>;
};

function createHarness(kind: 'resource' | 'toolCall', limits?: LimitOverrides) {
  const logViolation = jest.fn().mockResolvedValue(undefined);
  const middleware = createMCPAppRateLimiter(kind, {
    store: new MemoryStore(),
    logViolation,
    score: 3,
  });

  const invoke = (): Promise<Invocation> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      const request = {
        user: { id: 'user-1' },
        config: limits ? { config: { rateLimits: { mcpApps: limits } } } : { config: {} },
      } as unknown as Request;
      const response = {
        headersSent: false,
        setHeader(name: string, value: string | number) {
          headers[name.toLowerCase()] = String(value);
          return response;
        },
        status(code: number) {
          response.statusCode = code;
          return response;
        },
        json(body: unknown) {
          resolve({ status: response.statusCode, body, headers });
          return response;
        },
        statusCode: 200,
      } as unknown as Response;
      const next: NextFunction = (error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ status: 200, headers });
      };

      middleware(request, response, next);
    });

  return { invoke, logViolation };
}

describe('createMCPAppRateLimiter', () => {
  it.each([
    ['resource' as const, '120'],
    ['toolCall' as const, '60'],
  ])('uses the schema default for %s requests', async (kind, expected) => {
    const { invoke } = createHarness(kind);

    const response = await invoke();

    expect(response.status).toBe(200);
    expect(response.headers['x-ratelimit-limit']).toBe(expected);
  });

  it.each([
    ['resource' as const, { resourcesPerMinute: 2 }, 'resource'],
    ['toolCall' as const, { toolCallsPerMinute: 2 }, 'tool call'],
  ])(
    'applies the request-scoped %s limit and reports its effective value',
    async (kind, limits, label) => {
      const { invoke, logViolation } = createHarness(kind, limits);

      expect((await invoke()).status).toBe(200);
      expect((await invoke()).status).toBe(200);
      const limited = await invoke();

      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({
        message: `Too many app ${label} requests. Try again later`,
      });
      expect(logViolation).toHaveBeenCalledWith(
        expect.objectContaining({ user: { id: 'user-1' } }),
        expect.anything(),
        'tool_call_limit',
        {
          type: 'tool_call_limit',
          max: 2,
          limiter: 'user',
          windowInMinutes: 1,
        },
        3,
      );
    },
  );
});

describe('createMCPAppAdmissionRateLimiter', () => {
  it('shares the base-policy limit across App operation kinds for one user', async () => {
    const logViolation = jest.fn().mockResolvedValue(undefined);
    const middleware = createMCPAppAdmissionRateLimiter({
      store: new MemoryStore(),
      getLimit: () => 2,
      logViolation,
    });
    const invoke = (): Promise<Invocation> =>
      new Promise((resolve, reject) => {
        const headers: Record<string, string> = {};
        const request = { user: { id: 'user-1' } } as unknown as Request;
        const response = {
          headersSent: false,
          setHeader(name: string, value: string | number) {
            headers[name.toLowerCase()] = String(value);
            return response;
          },
          status(code: number) {
            response.statusCode = code;
            return response;
          },
          json(body: unknown) {
            resolve({ status: response.statusCode, body, headers });
            return response;
          },
          statusCode: 200,
        } as unknown as Response;
        middleware(request, response, (error?: unknown) => {
          if (error) {
            reject(error);
          } else {
            resolve({ status: 200, headers });
          }
        });
      });

    expect((await invoke()).status).toBe(200);
    expect((await invoke()).status).toBe(200);
    const limited = await invoke();

    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ message: 'Too many app requests. Try again later' });
    expect(logViolation).toHaveBeenCalledWith(
      expect.objectContaining({ user: { id: 'user-1' } }),
      expect.anything(),
      'tool_call_limit',
      expect.objectContaining({ max: 2, limiter: 'user' }),
      undefined,
    );
  });

  it('uses the shared default when registry policy resolution fails', async () => {
    const middleware = createMCPAppAdmissionRateLimiter({
      store: new MemoryStore(),
      getLimit: () => {
        throw new Error('registry unavailable');
      },
      logViolation: jest.fn().mockResolvedValue(undefined),
    });
    const headers: Record<string, string> = {};
    const request = { user: { id: 'user-2' } } as unknown as Request;
    const response = {
      setHeader(name: string, value: string | number) {
        headers[name.toLowerCase()] = String(value);
        return response;
      },
    } as unknown as Response;

    await new Promise<void>((resolve, reject) => {
      middleware(request, response, (error?: unknown) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });

    expect(headers['x-ratelimit-limit']).toBe('240');
  });
});

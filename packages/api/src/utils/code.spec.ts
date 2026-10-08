import { AxiosError, AxiosHeaders } from 'axios';
import {
  getCodeApiRetryAfterMs,
  getCodeApiUploadOptions,
  withCodeApiRateLimit,
  withCodeApiUploadRecovery,
  withCodeApiUploadSlot,
  createCodeApiRateLimitBudget,
  createCodeApiUploadRegistry,
} from './code';
import { wrapCodeApiUploadError } from './axios';

/** Builds the error axios raises for a Code API rate-limit response. */
function rateLimited({
  status = 429,
  headers = {},
  data = {},
}: {
  status?: number;
  headers?: Record<string, string>;
  data?: unknown;
} = {}): AxiosError {
  const error = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  error.response = {
    status,
    statusText: '',
    headers: new AxiosHeaders(headers),
    config: { headers: new AxiosHeaders() },
    data,
  };
  return error;
}

describe('wrapCodeApiUploadError', () => {
  it('preserves Axios rate-limit metadata on the contextual error', () => {
    const cause = rateLimited({ headers: { 'retry-after': '7' } });

    expect(wrapCodeApiUploadError(cause, 'Upload failed')).toMatchObject({
      cause,
      isAxiosError: true,
      response: { status: 429 },
    });
  });
});

describe('getCodeApiRetryAfterMs', () => {
  it('reads the standard Retry-After header', () => {
    expect(getCodeApiRetryAfterMs(rateLimited({ headers: { 'retry-after': '17' } }))).toBe(17_000);
  });

  it('falls back to the response body when a proxy dropped the header', () => {
    expect(getCodeApiRetryAfterMs(rateLimited({ data: { retry_after_seconds: 4 } }))).toBe(4_000);
  });

  it('prefers the header over the body', () => {
    const error = rateLimited({
      headers: { 'retry-after': '2' },
      data: { retry_after_seconds: 30 },
    });
    expect(getCodeApiRetryAfterMs(error)).toBe(2_000);
  });

  it('returns null for a non-429 response', () => {
    expect(getCodeApiRetryAfterMs(rateLimited({ status: 503 }))).toBeNull();
  });

  it('returns null when neither channel carries a usable delay', () => {
    expect(getCodeApiRetryAfterMs(rateLimited({ headers: { 'retry-after': 'soon' } }))).toBeNull();
    expect(getCodeApiRetryAfterMs(rateLimited({ data: 'rate_limited' }))).toBeNull();
  });

  it('treats a blank header as absent rather than "retry immediately"', () => {
    /* `Number('')` is 0, which would both skip the body fallback and read
     * as a zero-second wait. */
    const error = rateLimited({ headers: { 'retry-after': '' }, data: { retry_after_seconds: 9 } });
    expect(getCodeApiRetryAfterMs(error)).toBe(9_000);
  });

  it('returns null for anything that is not an axios error', () => {
    expect(getCodeApiRetryAfterMs(new Error('boom'))).toBeNull();
    expect(getCodeApiRetryAfterMs(undefined)).toBeNull();
  });
});

describe('withCodeApiRateLimit', () => {
  it('passes a successful attempt straight through', async () => {
    const attempt = jest.fn(async () => 'ok');
    await expect(withCodeApiRateLimit({ attempt, label: 'reading' })).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('waits out a rate limit the budget can absorb, then finishes', async () => {
    /* A multi-request operation would otherwise abandon the work already
     * done the moment a limiter window closes mid-flight. */
    const budget = createCodeApiRateLimitBudget(5_000);
    const waits: number[] = [];
    let attempts = 0;
    const attempt = jest.fn(async () => {
      attempts++;
      if (attempts === 1) {
        throw rateLimited({ headers: { 'retry-after': '1' } });
      }
      return 'ok';
    });

    await expect(
      withCodeApiRateLimit({ attempt, label: 'reading', budget, onWait: (ms) => waits.push(ms) }),
    ).resolves.toBe('ok');

    expect(attempts).toBe(2);
    expect(waits).toEqual([1_000]);
    expect(budget.waitedMs).toBeGreaterThanOrEqual(1_000);
  });

  it('names the limit when the wait exceeds the remaining budget', async () => {
    const budget = createCodeApiRateLimitBudget(5_000);
    const attempt = jest.fn(async () => {
      throw rateLimited({ headers: { 'retry-after': '300' } });
    });

    await expect(
      withCodeApiRateLimit({ attempt, label: 'reading "x.png"', budget }),
    ).rejects.toMatchObject({
      name: 'CodeApiRateLimitError',
      code: 'CODE_API_RATE_LIMITED',
      status: 429,
      statusCode: 429,
      retryAfterMs: 300_000,
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(budget.waitedMs).toBe(0);
  });

  it('names the limit even when the response carries no usable delay', async () => {
    /* Otherwise a bare "Request failed with status code 429" surfaces as an
     * unspecified failure instead of one that clears on its own. */
    const attempt = jest.fn(async () => {
      throw rateLimited();
    });

    await expect(
      withCodeApiRateLimit({
        attempt,
        label: 'reading',
        budget: createCodeApiRateLimitBudget(60_000),
      }),
    ).rejects.toMatchObject({
      name: 'CodeApiRateLimitError',
      code: 'CODE_API_RATE_LIMITED',
      status: 429,
      statusCode: 429,
    });
  });

  it('waits at least a second so a zero delay cannot spin', async () => {
    const budget = createCodeApiRateLimitBudget(2_500);
    const waits: number[] = [];
    let attempts = 0;
    const attempt = jest.fn(async () => {
      attempts++;
      if (attempts < 3) {
        throw rateLimited({ headers: { 'retry-after': '0' } });
      }
      return 'ok';
    });

    await expect(
      withCodeApiRateLimit({ attempt, label: 'reading', budget, onWait: (ms) => waits.push(ms) }),
    ).resolves.toBe('ok');
    expect(waits).toEqual([1_000, 1_000]);
  });

  it('rethrows anything that is not a rate limit', async () => {
    const attempt = jest.fn(async () => {
      throw rateLimited({ status: 500 });
    });
    await expect(withCodeApiRateLimit({ attempt, label: 'reading' })).rejects.toThrow(
      'Request failed',
    );
  });

  it('stops waiting when the calling operation is cancelled', async () => {
    const controller = new AbortController();
    const attempt = jest.fn(async () => {
      throw rateLimited({ headers: { 'retry-after': '10' } });
    });

    const pending = withCodeApiRateLimit({
      attempt,
      label: 'uploading',
      budget: createCodeApiRateLimitBudget(20_000),
      signal: controller.signal,
      onWait: () => controller.abort(),
    });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('shares elapsed wall time across concurrent waits', async () => {
    const budget = createCodeApiRateLimitBudget(2_500);
    const attempts = [0, 0, 0];
    const run = (index: number) =>
      withCodeApiRateLimit({
        budget,
        label: `uploading ${index}`,
        attempt: async () => {
          if (attempts[index]++ === 0) {
            throw rateLimited({ headers: { 'retry-after': '0' } });
          }
          return index;
        },
      });

    await expect(Promise.all([run(0), run(1), run(2)])).resolves.toEqual([0, 1, 2]);
  });

  it('does not charge successful request execution against the wait budget', async () => {
    jest.useFakeTimers();
    try {
      const budget = createCodeApiRateLimitBudget(1_500);
      let attempts = 0;
      const pending = withCodeApiRateLimit({
        budget,
        label: 'reading windows',
        attempt: async () => {
          attempts++;
          if (attempts === 1) {
            await new Promise((resolve) => setTimeout(resolve, 30_000));
            throw rateLimited({ headers: { 'retry-after': '1' } });
          }
          return 'ok';
        },
      });

      await jest.advanceTimersByTimeAsync(30_000);
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toBe('ok');
      expect(budget.waitedMs).toBe(1_000);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('withCodeApiUploadSlot', () => {
  it('removes a canceled caller from a busy scope immediately', async () => {
    const registry = createCodeApiUploadRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withCodeApiUploadSlot({
      registry,
      scope: 'route:user-a',
      concurrency: 1,
      task: () => gate,
    });
    const controller = new AbortController();
    const queuedTask = jest.fn(async () => undefined);
    const queued = withCodeApiUploadSlot({
      registry,
      scope: 'route:user-a',
      concurrency: 1,
      signal: controller.signal,
      task: queuedTask,
    });

    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(queuedTask).not.toHaveBeenCalled();
    release();
    await first;
  });

  it('does not block a different principal and route scope', async () => {
    const registry = createCodeApiUploadRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withCodeApiUploadSlot({
      registry,
      scope: 'route-a:user-a',
      concurrency: 1,
      task: () => gate,
    });
    const independent = jest.fn(async () => 'ok');

    await expect(
      withCodeApiUploadSlot({
        registry,
        scope: 'route-b:user-b',
        concurrency: 1,
        task: independent,
      }),
    ).resolves.toBe('ok');
    expect(independent).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});

describe('withCodeApiUploadRecovery', () => {
  it('disposes a failed source before opening the retry source', async () => {
    jest.useFakeTimers();
    try {
      const first = { destroy: jest.fn() };
      const second = { destroy: jest.fn() };
      const openSource = jest
        .fn<Promise<typeof first>, []>()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      const upload = jest
        .fn<Promise<string>, [typeof first]>()
        .mockRejectedValueOnce(rateLimited({ headers: { 'retry-after': '0' } }))
        .mockResolvedValueOnce('ok');

      const pending = withCodeApiUploadRecovery({
        registry: createCodeApiUploadRegistry(),
        scope: 'route:user',
        budget: createCodeApiRateLimitBudget(2_000),
        label: 'uploading',
        openSource,
        upload,
      });
      await jest.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toBe('ok');
      expect(first.destroy).toHaveBeenCalledTimes(1);
      expect(second.destroy).not.toHaveBeenCalled();
      expect(upload.mock.calls.map(([source]) => source)).toEqual([first, second]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('disposes every stream in a failed batch source', async () => {
    const first = { stream: { destroy: jest.fn() } };
    const second = { stream: { destroy: jest.fn() } };

    await expect(
      withCodeApiUploadRecovery({
        registry: createCodeApiUploadRegistry(),
        scope: 'route:user',
        budget: createCodeApiRateLimitBudget(0),
        label: 'uploading',
        openSource: async () => [first, second],
        upload: async () => {
          throw rateLimited({ headers: { 'retry-after': '30' } });
        },
      }),
    ).rejects.toMatchObject({ code: 'CODE_API_RATE_LIMITED' });
    expect(first.stream.destroy).toHaveBeenCalledTimes(1);
    expect(second.stream.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not classify a backing-storage 429 as Code API throttling', async () => {
    const storageRateLimit = rateLimited({ headers: { 'retry-after': '1' } });
    const upload = jest.fn();

    await expect(
      withCodeApiUploadRecovery({
        registry: createCodeApiUploadRegistry(),
        scope: 'route:user',
        budget: createCodeApiRateLimitBudget(2_000),
        label: 'uploading',
        openSource: async () => {
          throw storageRateLimit;
        },
        upload,
      }),
    ).rejects.toBe(storageRateLimit);
    expect(upload).not.toHaveBeenCalled();
  });

  it('disposes a source acquired as cancellation arrives', async () => {
    const controller = new AbortController();
    const source = { destroy: jest.fn() };
    const upload = jest.fn();

    await expect(
      withCodeApiUploadRecovery({
        registry: createCodeApiUploadRegistry(),
        scope: 'route:user',
        signal: controller.signal,
        label: 'uploading',
        openSource: async () => {
          controller.abort();
          return source;
        },
        upload,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(source.destroy).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('getCodeApiUploadOptions', () => {
  it('uses the configured limit and isolates tenants, principals, and routes', () => {
    const first = getCodeApiUploadOptions(
      {
        user: { id: 'user-a', tenantId: 'tenant-a' },
        config: { endpoints: { agents: { codeApiUploadConcurrency: 7 } } },
      } as never,
      'route-a',
    );
    const second = getCodeApiUploadOptions(
      { user: { id: 'user-a', tenantId: 'tenant-b' } } as never,
      'route-a',
    );

    expect(first.concurrency).toBe(7);
    expect(second.concurrency).toBe(3);
    expect(first.retryWaitMs).toBe(20_000);
    expect(first.scope).not.toBe(second.scope);
    expect(first.scope).not.toBe(
      getCodeApiUploadOptions({ user: { id: 'user-b', tenantId: 'tenant-a' } } as never, 'route-a')
        .scope,
    );
    expect(first.scope).not.toBe(
      getCodeApiUploadOptions({ user: { id: 'user-a', tenantId: 'tenant-a' } } as never, 'route-b')
        .scope,
    );
  });
});

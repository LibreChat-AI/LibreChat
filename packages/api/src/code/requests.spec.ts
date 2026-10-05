import { trace } from '@opentelemetry/api';
import { logger } from '@librechat/data-schemas';
import { codeEnvironmentAdmissionSchema } from 'librechat-data-provider';
import { executeWorkspaceTool } from './workspace';

const request = {
  protocolVersion: 1 as const,
  operation: 'read_file' as const,
  workspaceId: 'root',
  path: 'README.md',
};
const result = { ...request, content: 'hello', startLine: 1, endLine: 1, truncated: false };
const requestId = 'durable-request-000001';
const input = {
  baseURL: 'https://code.example/v1',
  request,
  requestId,
  authHeaders: () => ({ Authorization: 'fresh' }),
  maxQueueWaitMs: 1000,
  admission: codeEnvironmentAdmissionSchema.parse({ durableRequests: true, pollIntervalMs: 100 }),
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const status = (state: string) =>
  json({ requestId, state, ...(state === 'completed' ? { result } : {}) }, 202);

test('keeps one logical request across admission polls, with refreshed credentials', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(status('queued'))
    .mockResolvedValueOnce(status('admitted'))
    .mockResolvedValueOnce(status('completed'));
  const authHeaders = jest.fn(input.authHeaders);
  expect(await executeWorkspaceTool({ ...input, authHeaders, fetchImpl })).toEqual(result);
  expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual([
    'GET',
    'POST',
    'GET',
    'GET',
  ]);
  expect(fetchImpl.mock.calls[1][1].headers['X-LibreChat-Workspace-Request-Id']).toBe(requestId);
  expect(authHeaders).toHaveBeenCalledTimes(4);
});

test('recovers a lost submission response by lookup without rejoining admission', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockRejectedValueOnce(new TypeError('lost response'))
    .mockResolvedValueOnce(status('completed'));
  expect(await executeWorkspaceTool({ ...input, fetchImpl })).toEqual(result);
  expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

test('falls back only when capability discovery explicitly says unsupported', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({}, 404))
    .mockResolvedValueOnce(json(result));
  expect(await executeWorkspaceTool({ ...input, fetchImpl })).toEqual(result);
  expect(fetchImpl.mock.calls[1][0]).toBe('https://code.example/v1/workspace-tools/execute');
});

test('never falls back or resubmits a previously observed handle after a missing lookup', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(status('queued'))
    .mockResolvedValueOnce(json({}, 404));
  await expect(executeWorkspaceTool({ ...input, fetchImpl })).rejects.toThrow('invalid');
  expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

test('abort cancels the same handle with an independent signal', async () => {
  const controller = new AbortController();
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockImplementationOnce(async () => {
      controller.abort();
      return status('queued');
    })
    .mockResolvedValueOnce(status('cancelled'));
  await expect(
    executeWorkspaceTool({ ...input, signal: controller.signal, fetchImpl }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchImpl.mock.calls[2][0]).toContain(requestId);
  expect(fetchImpl.mock.calls[2][1].method).toBe('DELETE');
  expect(fetchImpl.mock.calls[2][1].signal.aborted).toBe(false);
});

test('terminal upstream diagnostics do not expose submitted content', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(
      json(
        {
          requestId,
          state: 'failed',
          error: { code: 'ASSIGNMENT_EXPIRED', message: 'secret command' },
        },
        202,
      ),
    );
  await expect(executeWorkspaceTool({ ...input, fetchImpl })).rejects.not.toThrow('secret command');
});

test('a short transport ceiling does not consume the execution reserve on durable servers', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(status('queued'))
    .mockResolvedValueOnce(status('completed'));
  expect(await executeWorkspaceTool({ ...input, maxRequestTimeoutMs: 1000, fetchImpl })).toEqual(
    result,
  );
});

test('malformed discovery fails closed instead of dispatching synchronously', async () => {
  const fetchImpl = jest.fn().mockResolvedValue(json({ unsupported: true }));
  await expect(executeWorkspaceTool({ ...input, fetchImpl })).rejects.toThrow('invalid');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('lost submission with absent lookup retries only the identical request identity', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockRejectedValueOnce(new TypeError('lost'))
    .mockResolvedValueOnce(json({}, 404))
    .mockResolvedValueOnce(status('completed'));
  expect(
    await executeWorkspaceTool({
      ...input,
      admission: codeEnvironmentAdmissionSchema.parse({
        durableRequests: true,
        queueWaitMs: 100,
        pollIntervalMs: 100,
      }),
      fetchImpl,
    }),
  ).toEqual(result);
  const posts = fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[0][1].headers['X-LibreChat-Workspace-Request-Id']).toBe(
    posts[1][1].headers['X-LibreChat-Workspace-Request-Id'],
  );
  expect(posts[0][1].body).toBe(posts[1][1].body);
});

test('rejects a run unable to reserve the complete execution budget before submission', async () => {
  const fetchImpl = jest.fn();
  await expect(
    executeWorkspaceTool({ ...input, maxRunTimeoutMs: 1000, fetchImpl }),
  ).rejects.toThrow('cannot fit');
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('zero queue retries still permits the initial durable admission attempt', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(status('completed'));
  expect(await executeWorkspaceTool({ ...input, maxQueueWaitMs: 0, fetchImpl })).toEqual(result);
  const post = fetchImpl.mock.calls.find(([, init]) => init.method === 'POST');
  expect(Number(post?.[1].headers['X-LibreChat-Workspace-Queue-Wait-Ms'])).toBeGreaterThan(0);
});

test('recovers a broken 202 body by lookup, not a second submission', async () => {
  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"requestId":'));
      controller.error(new TypeError('connection reset'));
    },
  });
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(new Response(broken, { status: 202 }))
    .mockResolvedValueOnce(status('completed'));
  expect(await executeWorkspaceTool({ ...input, fetchImpl })).toEqual(result);
  expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

test('clamps server admission to the run budget minus execution and delivery', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(status('completed'));
  const started = Date.now();
  expect(
    await executeWorkspaceTool({
      ...input,
      maxQueueWaitMs: 300000,
      maxRunTimeoutMs: 60000,
      fetchImpl,
    }),
  ).toEqual(result);
  const post = fetchImpl.mock.calls.find(([, init]) => init.method === 'POST');
  const allowance = Number(post?.[1].headers['X-LibreChat-Workspace-Queue-Wait-Ms']);
  expect(allowance).toBeLessThanOrEqual(25000);
  expect(allowance).toBeLessThanOrEqual(started + 60000 - Date.now() - 35000 + 100);
});

test.each(['EDIT_CONFLICT', 'FILE_EXISTS', 'WORKSPACE_QUARANTINED'])(
  'preserves conflict status for retained %s',
  async (code) => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
      .mockResolvedValueOnce(
        json(
          { requestId, state: 'failed', error: { code, message: 'private submitted content' } },
          202,
        ),
      );
    await expect(executeWorkspaceTool({ ...input, fetchImpl })).rejects.toMatchObject({
      upstreamStatus: 409,
      upstreamCode: code,
    });
  },
);

test.each(['completed', 'queued'])(
  'resumes an accepted %s handle through lookup only',
  async (state) => {
    const { requestId: _fresh, ...resumeInput } = input;
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
      .mockResolvedValueOnce(status(state))
      .mockResolvedValueOnce(status('completed'));
    expect(
      await executeWorkspaceTool({ ...resumeInput, resumeRequestId: requestId, fetchImpl }),
    ).toEqual(result);
    expect(fetchImpl.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  },
);

test.each([404, 0])(
  'never falls back or posts a resumed handle on unsupported discovery (%s)',
  async (unsupported) => {
    const { requestId: _fresh, ...resumeInput } = input;
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        unsupported === 404 ? json({}, 404) : json({ durableWorkspaceRequests: 0 }),
      )
      .mockResolvedValueOnce(status('cancelled'));
    await expect(
      executeWorkspaceTool({ ...resumeInput, resumeRequestId: requestId, fetchImpl }),
    ).rejects.toMatchObject({ reason: 'invalid' });
    expect(fetchImpl.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false);
  },
);

test('an expired resumed handle cannot recreate a command or write', async () => {
  const { requestId: _fresh, ...resumeInput } = input;
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(json({}, 404))
    .mockResolvedValueOnce(json({}, 404));
  await expect(
    executeWorkspaceTool({ ...resumeInput, resumeRequestId: requestId, fetchImpl }),
  ).rejects.toMatchObject({ reason: 'invalid' });
  expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'GET', 'DELETE']);
});

test('fresh and resume identities are mutually exclusive and resuming cannot use the legacy path', async () => {
  const fetchImpl = jest.fn();
  await expect(
    executeWorkspaceTool({ ...input, resumeRequestId: requestId, fetchImpl }),
  ).rejects.toMatchObject({ reason: 'invalid' });
  const { requestId: _fresh, ...resumeInput } = input;
  await expect(
    executeWorkspaceTool({
      ...resumeInput,
      resumeRequestId: requestId,
      admission: undefined,
      fetchImpl,
    }),
  ).rejects.toMatchObject({ reason: 'invalid' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('lookup failures after an accepted 202 body never authorize another submission', async () => {
  const broken = new ReadableStream<Uint8Array>({
    start(c) {
      c.error(new TypeError('connection reset'));
    },
  });
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(new Response(broken, { status: 202 }))
    .mockResolvedValueOnce(json({}, 404))
    .mockResolvedValueOnce(status('cancelled'));
  await expect(executeWorkspaceTool({ ...input, fetchImpl })).rejects.toMatchObject({
    reason: 'invalid',
  });
  expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  expect(fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1]?.[1].method).toBe('DELETE');
});

test('malformed or oversized accepted bodies fail closed and cancel, without treating them as transport loss', async () => {
  for (const body of ['{"broken":', 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
      .mockResolvedValueOnce(new Response(body, { status: 202 }))
      .mockResolvedValueOnce(status('cancelled'));
    await expect(executeWorkspaceTool({ ...input, fetchImpl })).rejects.toMatchObject({
      reason: 'invalid',
    });
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'POST', 'DELETE']);
  }
});

test('retries a lost retained-result body through lookup without a second command', async () => {
  const broken = new ReadableStream<Uint8Array>({
    start(c) {
      c.error(new Error('socket interrupted'));
    },
  });
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(status('admitted'))
    .mockResolvedValueOnce(new Response(broken))
    .mockResolvedValueOnce(status('completed'));
  expect(await executeWorkspaceTool({ ...input, fetchImpl })).toEqual(result);
  expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

test('credential and discovery delays reduce the server queue allowance before the first POST', async () => {
  let now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  const authHeaders = jest.fn(async () => {
    now += 1000;
    return {};
  });
  const fetchImpl = jest
    .fn()
    .mockImplementationOnce(async () => {
      now += 2000;
      return json({ durableWorkspaceRequests: 1 });
    })
    .mockResolvedValueOnce(status('completed'));
  try {
    expect(
      await executeWorkspaceTool({
        ...input,
        maxQueueWaitMs: 300000,
        maxRunTimeoutMs: 60000,
        authHeaders,
        fetchImpl,
      }),
    ).toEqual(result);
    expect(Number(fetchImpl.mock.calls[1][1].headers['X-LibreChat-Workspace-Queue-Wait-Ms'])).toBe(
      21000,
    );
  } finally {
    clock.mockRestore();
  }
});

test('a lost POST is never resent with an allowance that extends past the original run', async () => {
  jest.useFakeTimers();
  const fetchImpl = jest.fn().mockImplementation(async (url, init) => {
    if (String(url).endsWith('/capabilities')) return json({ durableWorkspaceRequests: 1 });
    if (init.method === 'POST') throw new TypeError('lost');
    return json({}, 404);
  });
  try {
    const pending = executeWorkspaceTool({
      ...input,
      maxRunTimeoutMs: 35100,
      maxQueueWaitMs: 300000,
      fetchImpl,
    }).catch((e) => e);
    await jest.advanceTimersByTimeAsync(35100);
    expect(await pending).toMatchObject({ reason: 'timeout' });
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1]?.[1].method).toBe('DELETE');
  } finally {
    jest.useRealTimers();
  }
});

test.each([
  ['WORKER_OFFLINE', 503],
  ['WORKSPACE_QUEUE_TIMEOUT', 503],
  ['WORKER_QUEUE_FULL', 429],
  ['ASSIGNMENT_EXPIRED', 504],
  ['SEARCH_TIMEOUT', 504],
  ['RESULT_INVALID', 502],
  ['WORKER_UNAUTHORIZED', 403],
  ['WRITE_DISABLED', 403],
  ['WRITE_LIMIT_EXCEEDED', 413],
  ['ASSIGNMENT_INVALID', 400],
  ['NOT_FOUND', 422],
  ['EXECUTION_ABORTED', 422],
  ['UNKNOWN_PROVIDER_CODE', 422],
  ['constructor', 422],
])('maps retained %s to the established domain status %s', async (code, expectedStatus) => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(
      json({ requestId, state: 'failed', error: { code, message: 'sensitive diagnostics' } }, 202),
    );
  await expect(executeWorkspaceTool({ ...input, fetchImpl })).rejects.toMatchObject({
    upstreamStatus: expectedStatus,
    upstreamCode: ['UNKNOWN_PROVIDER_CODE', 'constructor'].includes(String(code))
      ? 'WORKSPACE_TOOL_REJECTED'
      : code,
    upstreamBody: expect.not.stringContaining('sensitive diagnostics'),
  });
});

test.each(['completed', 'failed', 'discovery', 'fallback', 'cancelled'])(
  'records one shared span/outcome for durable %s',
  async (scenario) => {
    const tracer = trace.getTracer('librechat.workspace');
    const original = tracer.startSpan.bind(tracer);
    const attributes = jest.fn(),
      end = jest.fn();
    const start = jest.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
      const span = original(...args);
      jest.spyOn(span, 'setAttributes').mockImplementation((value) => {
        attributes(value);
        return span;
      });
      jest.spyOn(span, 'end').mockImplementation(() => {
        end();
      });
      return span;
    });
    const get = jest.spyOn(trace, 'getTracer').mockReturnValue(tracer);
    const log = jest.spyOn(logger, 'debug');
    const fetchImpl = jest.fn();
    const controller = new AbortController();
    if (scenario === 'fallback')
      fetchImpl.mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json(result));
    else if (scenario === 'discovery') fetchImpl.mockResolvedValueOnce(json({ unsupported: true }));
    else {
      fetchImpl.mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }));
      if (scenario === 'cancelled')
        fetchImpl
          .mockImplementationOnce(async () => {
            controller.abort();
            return status('queued');
          })
          .mockResolvedValueOnce(status('cancelled'));
      else
        fetchImpl.mockResolvedValueOnce(
          scenario === 'failed'
            ? json({ requestId, state: 'failed', error: { code: 'EDIT_CONFLICT' } }, 202)
            : status('completed'),
        );
    }
    try {
      await executeWorkspaceTool({ ...input, signal: controller.signal, fetchImpl }).catch(
        () => undefined,
      );
      expect(start).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledTimes(1);
      const outcomes: Record<string, string> = {
        discovery: 'invalid',
        failed: 'rejected',
        cancelled: 'cancelled',
      };
      const expectedOutcome = outcomes[scenario] ?? 'completed';
      expect(attributes).toHaveBeenCalledWith(
        expect.objectContaining({
          'workspace.outcome': expectedOutcome,
          'workspace.transport': scenario === 'fallback' ? 'synchronous' : 'durable',
        }),
      );
      expect(
        log.mock.calls.filter(([message]) => String(message) === '[WorkspaceAdmission] outcome'),
      ).toHaveLength(1);
    } finally {
      start.mockRestore();
      get.mockRestore();
      log.mockRestore();
    }
  },
);

test('resuming a completed request does not need a fresh execution reserve', async () => {
  const { requestId: _fresh, ...resumeInput } = input;
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(status('completed'));
  expect(
    await executeWorkspaceTool({
      ...resumeInput,
      resumeRequestId: requestId,
      maxRunTimeoutMs: 1000,
      fetchImpl,
    }),
  ).toEqual(result);
  expect(fetchImpl.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
});

test('a terminal server cancellation retains its cancellation outcome', async () => {
  const log = jest.spyOn(logger, 'debug');
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(status('cancelled'));
  try {
    await expect(executeWorkspaceTool({ ...input, fetchImpl })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(log).toHaveBeenCalledWith(
      '[WorkspaceAdmission] outcome',
      expect.objectContaining({ outcome: 'cancelled' }),
    );
  } finally {
    log.mockRestore();
  }
});

test('an accepted body reset at the transport deadline recovers by lookup, not replay', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockImplementationOnce(
      async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init.signal.addEventListener(
                'abort',
                () => controller.error(new TypeError('terminated')),
                { once: true },
              );
            },
          }),
          { status: 202 },
        ),
    )
    .mockResolvedValueOnce(status('completed'));
  expect(await executeWorkspaceTool({ ...input, maxRequestTimeoutMs: 1000, fetchImpl })).toEqual(
    result,
  );
  expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

test('successful lookup headers latch acceptance even when its body is lost before a missing lookup', async () => {
  const broken = new ReadableStream<Uint8Array>({
    start(c) {
      c.error(new TypeError('reset'));
    },
  });
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockRejectedValueOnce(new TypeError('lost POST response'))
    .mockResolvedValueOnce(new Response(broken))
    .mockResolvedValueOnce(json({}, 404))
    .mockResolvedValueOnce(status('completed'));
  await expect(
    executeWorkspaceTool({
      ...input,
      admission: codeEnvironmentAdmissionSchema.parse({
        durableRequests: true,
        queueWaitMs: 100,
        pollIntervalMs: 100,
      }),
      fetchImpl,
    }),
  ).rejects.toMatchObject({ reason: 'invalid' });
  expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual([
    'GET',
    'POST',
    'GET',
    'GET',
    'DELETE',
  ]);
});

test('typed pre-admission rate limits retry one durable identity with refreshed credentials', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'Retry-After': '1' },
      }),
    )
    .mockResolvedValueOnce(status('completed'));
  const authHeaders = jest.fn(input.authHeaders);
  expect(
    await executeWorkspaceTool({ ...input, authHeaders, codeApiMaxRetryWaitMs: 1000, fetchImpl }),
  ).toEqual(result);
  expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'POST', 'POST']);
  const posts = fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST');
  expect(posts[0][1].headers['X-LibreChat-Workspace-Request-Id']).toBe(
    posts[1][1].headers['X-LibreChat-Workspace-Request-Id'],
  );
  expect(authHeaders).toHaveBeenCalledTimes(3);
});

test.each([0, 999])(
  'typed throttling exceeding its wait budget fails without submitting work (%s)',
  async (budget) => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: { 'Retry-After': '1' },
        }),
      );
    await expect(
      executeWorkspaceTool({ ...input, codeApiMaxRetryWaitMs: budget, fetchImpl }),
    ).rejects.toMatchObject({ upstreamStatus: 429 });
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'POST']);
  },
);

test.each([
  '{',
  '{"error":"unknown"}',
  '{"error":"rate_limited","padding":"' + 'x'.repeat(4096) + '"}',
])('unknown or incomplete durable 429 bodies are never retried (%s)', async (body) => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(new Response(body, { status: 429, headers: { 'Retry-After': '1' } }))
    .mockResolvedValueOnce(status('cancelled'));
  await expect(executeWorkspaceTool({ ...input, fetchImpl })).rejects.toMatchObject({
    upstreamStatus: 429,
  });
  expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

test('durable rate-limit hints and additive jitter cannot authorize an early POST', async () => {
  jest.useFakeTimers();
  const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'Retry-After': '1' },
      }),
    )
    .mockResolvedValueOnce(status('completed'));
  try {
    const pending = executeWorkspaceTool({
      ...input,
      admission: codeEnvironmentAdmissionSchema.parse({ durableRequests: true, jitterRatio: 0.5 }),
      codeApiMaxRetryWaitMs: 2000,
      fetchImpl,
    });
    await jest.advanceTimersByTimeAsync(1249);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(result);
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'POST', 'POST']);
  } finally {
    random.mockRestore();
    jest.useRealTimers();
  }
});

test('repeated typed throttling consumes one cumulative wait allowance', async () => {
  jest.useFakeTimers();
  const limited = () =>
    new Response(JSON.stringify({ error: 'rate_limited', retry_after_seconds: 1 }), {
      status: 429,
    });
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockImplementation(limited);
  try {
    const pending = executeWorkspaceTool({
      ...input,
      codeApiMaxRetryWaitMs: 1000,
      fetchImpl,
    }).catch((e) => e);
    await jest.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ upstreamStatus: 429 });
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'POST', 'POST']);
  } finally {
    jest.useRealTimers();
  }
});

test('rate-limit waiting cannot consume the reserved execution budget', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'Retry-After': '1' },
      }),
    );
  await expect(
    executeWorkspaceTool({
      ...input,
      maxRunTimeoutMs: 36000,
      codeApiMaxRetryWaitMs: 1000,
      fetchImpl,
    }),
  ).rejects.toMatchObject({ upstreamStatus: 429 });
  expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'POST']);
});

test('a typed rejection after uncertain submission does not recompute its fingerprint', async () => {
  const limited = () =>
    new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { 'Retry-After': '0' },
    });
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockRejectedValueOnce(new TypeError('lost'))
    .mockResolvedValueOnce(json({}, 404))
    .mockResolvedValueOnce(limited())
    .mockResolvedValueOnce(status('completed'));
  const admission = codeEnvironmentAdmissionSchema.parse({
    durableRequests: true,
    queueWaitMs: 100,
    pollIntervalMs: 100,
  });
  expect(await executeWorkspaceTool({ ...input, admission, fetchImpl })).toEqual(result);
  const posts = fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[0][1].body).toBe(posts[1][1].body);
  expect(posts[0][1].headers['X-LibreChat-Workspace-Queue-Wait-Ms']).toBe(
    posts[1][1].headers['X-LibreChat-Workspace-Queue-Wait-Ms'],
  );
});

test('accepted lookup throttling never authorizes a POST', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(status('queued'))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'Retry-After': '1' },
      }),
    )
    .mockResolvedValueOnce(status('cancelled'));
  await expect(executeWorkspaceTool({ ...input, fetchImpl })).rejects.toMatchObject({
    upstreamStatus: 429,
  });
  expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual([
    'GET',
    'POST',
    'GET',
    'DELETE',
  ]);
});

test('Stop during definite pre-admission rate waiting does not submit or cancel nonexistent work', async () => {
  const controller = new AbortController();
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockImplementationOnce(async () => {
      setImmediate(() => controller.abort());
      return new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'Retry-After': '1' },
      });
    });
  await expect(
    executeWorkspaceTool({ ...input, signal: controller.signal, fetchImpl }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'POST']);
});

test('durable throttling contributes to the shared aggregate admission outcome', async () => {
  jest.useFakeTimers();
  const log = jest.spyOn(logger, 'debug');
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'Retry-After': '1' },
      }),
    )
    .mockResolvedValueOnce(status('completed'));
  try {
    const pending = executeWorkspaceTool({ ...input, codeApiMaxRetryWaitMs: 1000, fetchImpl });
    await jest.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual(result);
    expect(log).toHaveBeenCalledWith(
      '[WorkspaceAdmission] outcome',
      expect.objectContaining({
        attempts: 2,
        rateLimitRejections: 1,
        rateLimitWaitedMs: 1000,
        retryWaitMs: 1000,
        outcome: 'completed',
        transport: 'durable',
      }),
    );
  } finally {
    log.mockRestore();
    jest.useRealTimers();
  }
});

test('capability 404 still falls back when discarding its failed body rejects', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError('connection reset'));
    },
  });
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(new Response(body, { status: 404 }))
    .mockResolvedValueOnce(json(result));
  expect(await executeWorkspaceTool({ ...input, fetchImpl })).toEqual(result);
  expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
    'https://code.example/v1/workspace-tools/capabilities',
    'https://code.example/v1/workspace-tools/execute',
  ]);
});

test('a failed 404 lookup body does not block recovery of a fresh uncertain submission', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.error(new Error('reset'));
    },
  });
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockRejectedValueOnce(new TypeError('lost response'))
    .mockResolvedValueOnce(new Response(body, { status: 404 }))
    .mockResolvedValueOnce(status('completed'));
  expect(
    await executeWorkspaceTool({
      ...input,
      admission: codeEnvironmentAdmissionSchema.parse({
        durableRequests: true,
        queueWaitMs: 100,
        pollIntervalMs: 100,
      }),
      fetchImpl,
    }),
  ).toEqual(result);
  const posts = fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[0][1].body).toBe(posts[1][1].body);
  expect(posts[0][1].headers['X-LibreChat-Workspace-Queue-Wait-Ms']).toBe(
    posts[1][1].headers['X-LibreChat-Workspace-Queue-Wait-Ms'],
  );
});

test('discard errors never grant POST authority for a missing accepted handle', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.error(new TypeError('reset'));
    },
  });
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(status('queued'))
    .mockResolvedValueOnce(new Response(body, { status: 404 }))
    .mockResolvedValueOnce(status('cancelled'));
  await expect(executeWorkspaceTool({ ...input, fetchImpl })).rejects.toMatchObject({
    reason: 'invalid',
  });
  expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual([
    'GET',
    'POST',
    'GET',
    'DELETE',
  ]);
});

test('resuming against an unsupported server never falls back despite a failed 404 body', async () => {
  const { requestId: _fresh, ...resumeInput } = input;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.error(new Error('reset'));
    },
  });
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(new Response(body, { status: 404 }))
    .mockResolvedValueOnce(status('cancelled'));
  await expect(
    executeWorkspaceTool({ ...resumeInput, resumeRequestId: requestId, fetchImpl }),
  ).rejects.toMatchObject({ reason: 'invalid' });
  expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'DELETE']);
});

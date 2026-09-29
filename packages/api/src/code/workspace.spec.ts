import type { WorkspaceToolRequest } from './workspace';
import type { CodeBridgeFetch } from './bridge';
import { executeWorkspaceTool, WorkspaceToolHttpError } from './workspace';

describe('workspace admission feedback', () => {
  test('forwards a valid conversation workspace instance unchanged', async () => {
    const workspaceInstanceId = 'd'.repeat(64);
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          operation: 'write_file',
          workspaceId: 'primary',
          path: 'notes.txt',
          created: true,
          bytesWritten: 5,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await executeWorkspaceTool({
      baseURL: 'https://code.example/v1',
      authHeaders: {},
      fetchImpl,
      request: {
        protocolVersion: 1,
        operation: 'write_file',
        workspaceId: 'primary',
        workspaceInstanceId,
        path: 'notes.txt',
        content: 'ready',
      },
    });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ workspaceInstanceId });
  });

  test('rejects malformed workspace instance identifiers before transport', async () => {
    const fetchImpl = jest.fn();
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        request: {
          protocolVersion: 1,
          operation: 'list_files',
          workspaceId: 'primary',
          workspaceInstanceId: 'conversation-1',
        },
      }),
    ).rejects.toBeInstanceOf(WorkspaceToolHttpError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('identifies definite pre-execution expiry without retrying the operation', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'WORKSPACE_QUEUE_TIMEOUT' }), {
        status: 503,
        headers: { 'Retry-After': '1' },
      }),
    );
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        maxQueueWaitMs: 0,
        request: {
          protocolVersion: 1,
          operation: 'execute_command',
          workspaceId: 'primary',
          command: 'echo test',
        },
      }),
    ).rejects.toThrow('The operation was not started');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('keeps one tool call queued when capacity expires before admission', async () => {
    const unavailable = () =>
      new Response(JSON.stringify({ code: 'WORKSPACE_QUEUE_TIMEOUT' }), {
        status: 503,
        headers: { 'Retry-After': '0' },
      });
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            operation: 'edit_file',
            workspaceId: 'primary',
            path: 'src/app.ts',
            replacements: 1,
            bytesWritten: 24,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        request: {
          protocolVersion: 1,
          operation: 'edit_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
          edits: [{ oldText: 'const old = true;', newText: 'const ready = true;' }],
        },
      }),
    ).resolves.toMatchObject({ operation: 'edit_file', replacements: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map((call) => call[1]?.body)).toEqual([
      fetchImpl.mock.calls[0][1]?.body,
      fetchImpl.mock.calls[0][1]?.body,
      fetchImpl.mock.calls[0][1]?.body,
    ]);
  });

  test('mints fresh credentials for every admission attempt', async () => {
    let minted = 0;
    const authHeaders = jest.fn(async () => ({ Authorization: `Bearer token-${++minted}` }));
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'WORKSPACE_QUEUE_TIMEOUT' }), {
          status: 503,
          headers: { 'Retry-After': '0' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            operation: 'edit_file',
            workspaceId: 'primary',
            path: 'src/app.ts',
            replacements: 1,
            bytesWritten: 24,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders,
        fetchImpl,
        request: {
          protocolVersion: 1,
          operation: 'edit_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
          edits: [{ oldText: 'const old = true;', newText: 'const ready = true;' }],
        },
      }),
    ).resolves.toMatchObject({ operation: 'edit_file' });

    // A token minted before the first capacity window expires within the
    // admission budget, so reusing it would fail the retry with a 401.
    expect(authHeaders).toHaveBeenCalledTimes(2);
    expect(
      fetchImpl.mock.calls.map(
        (call) => (call[1]?.headers as Record<string, string>).Authorization,
      ),
    ).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  test('never opens another admission window once the queue budget is spent', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 'WORKSPACE_QUEUE_TIMEOUT' }), {
          status: 503,
          headers: { 'Retry-After': '1' },
        }),
      );

      const result = executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        maxQueueWaitMs: 150,
        request: {
          protocolVersion: 1,
          operation: 'edit_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
          edits: [{ oldText: 'const old = true;', newText: 'const ready = true;' }],
        },
      }).catch((error: Error) => error);

      await jest.advanceTimersByTimeAsync(150);
      expect(await result).toMatchObject({
        message: expect.stringContaining('The operation was not started'),
      });

      // The clamped wait lands on the deadline: a further dispatch could still be
      // admitted and run a long command after the budget expired.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([true, false])(
    'does not dispatch when cancelled before or during credential refresh (%s)',
    async (beforeRefresh) => {
      const controller = new AbortController();
      const reason = new DOMException('Stopped', 'AbortError');
      const authHeaders = jest.fn(async () => {
        controller.abort(reason);
        return {};
      });
      const fetchImpl = jest.fn();
      if (beforeRefresh) controller.abort(reason);
      await expect(
        executeWorkspaceTool({
          baseURL: 'https://code.example/v1',
          authHeaders,
          fetchImpl,
          signal: controller.signal,
          request: {
            protocolVersion: 1,
            operation: 'read_file',
            workspaceId: 'primary',
            path: 'src/app.ts',
          },
        }),
      ).rejects.toBe(reason);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(authHeaders).toHaveBeenCalledTimes(beforeRefresh ? 0 : 1);
    },
  );

  test('cancels a stalled credential refresh without opening a workspace admission window', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Chat stopped', 'AbortError');
    const fetchImpl = jest.fn();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const operation = executeWorkspaceTool({
      baseURL: 'https://code.example.com/v1',
      authHeaders: async () => {
        entered();
        return new Promise<Record<string, string>>(() => {});
      },
      request: {
        protocolVersion: 1,
        operation: 'edit_file',
        workspaceId: 'primary',
        path: 'src/app.ts',
        edits: [{ oldText: 'a', newText: 'b' }],
      },
      signal: controller.signal,
      maxRequestTimeoutMs: 125_000,
      fetchImpl,
    });
    await started;
    controller.abort(reason);
    await expect(operation).rejects.toBe(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('does not dispatch a retry if credential refresh spends the remaining queue budget', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const authHeaders = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockImplementationOnce(async () => {
        now.mockReturnValue(2000);
        return {};
      });
    const fetchImpl = jest.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'WORKSPACE_QUEUE_TIMEOUT' }), {
        status: 503,
        headers: { 'Retry-After': '0' },
      }),
    );
    try {
      await expect(
        executeWorkspaceTool({
          baseURL: 'https://code.example/v1',
          authHeaders,
          fetchImpl,
          maxQueueWaitMs: 1000,
          request: {
            protocolVersion: 1,
            operation: 'read_file',
            workspaceId: 'primary',
            path: 'src/app.ts',
          },
        }),
      ).rejects.toThrow('The operation was not started');
      expect(authHeaders).toHaveBeenCalledTimes(2);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  test('stops waiting for capacity when the chat is cancelled', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Stopped', 'AbortError');
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'WORKSPACE_QUEUE_TIMEOUT' }), {
        status: 503,
        headers: { 'Retry-After': '1' },
      }),
    );
    const request = executeWorkspaceTool({
      baseURL: 'https://code.example/v1',
      authHeaders: {},
      fetchImpl,
      signal: controller.signal,
      request: {
        protocolVersion: 1,
        operation: 'read_file',
        workspaceId: 'primary',
        path: 'src/app.ts',
      },
    });
    while (fetchImpl.mock.calls.length === 0) await Promise.resolve();
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('cancels a typed rate-limit wait without replaying the request', async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const reason = new DOMException('Stopped', 'AbortError');
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'rate_limited' }), {
            status: 429,
            headers: { 'Retry-After': '1' },
          }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 504 }));
      const request = executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        signal: controller.signal,
        fetchImpl,
        maxQueueWaitMs: 0,
        request: { protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'x' },
      });

      await jest.advanceTimersByTimeAsync(1);
      controller.abort(reason);
      await expect(request).rejects.toBe(reason);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('retries a Code API rate limit, which rejects before the operation starts', async () => {
    const rateLimited = () =>
      new Response(
        JSON.stringify({
          error: 'rate_limited',
          message: 'Too many CodeAPI execution requests. Please retry in 1 second.',
          retry_after_seconds: 1,
        }),
        { status: 429, headers: { 'Retry-After': '0' } },
      );
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            operation: 'edit_file',
            workspaceId: 'primary',
            path: 'src/app.ts',
            replacements: 1,
            bytesWritten: 24,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        request: {
          protocolVersion: 1,
          operation: 'edit_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
          edits: [{ oldText: 'const old = true;', newText: 'const ready = true;' }],
        },
      }),
    ).resolves.toMatchObject({ operation: 'edit_file', replacements: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const bodies = fetchImpl.mock.calls.map((call) => call[1]?.body);
    expect(new Set(bodies).size).toBe(1);
  });

  test.each([
    ['missing', undefined],
    ['invalid', 'invalid'],
    ['overflowing', '9'.repeat(400)],
  ] as const)('uses the typed 429 body delay when Retry-After is %s', async (_case, retryAfter) => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'rate_limited', retry_after_seconds: 2 }), {
            status: 429,
            ...(retryAfter ? { headers: { 'Retry-After': retryAfter } } : {}),
          }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 504 }));
      const result = executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        codeApiMaxRetryWaitMs: 3_000,
        request: {
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: 'x',
        },
      }).catch((error: WorkspaceToolHttpError) => error);

      await jest.advanceTimersByTimeAsync(1_999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ upstreamStatus: 504 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([-1, 300_001, 1.5, Number.NaN])(
    'rejects an invalid Code API retry limit of %p before transport',
    async (codeApiMaxRetryWaitMs) => {
      const fetchImpl = jest.fn();
      await expect(
        executeWorkspaceTool({
          baseURL: 'https://code.example/v1',
          authHeaders: {},
          fetchImpl,
          codeApiMaxRetryWaitMs,
          request: {
            protocolVersion: 1,
            operation: 'read_file',
            workspaceId: 'primary',
            path: 'x',
          },
        }),
      ).rejects.toMatchObject({ reason: 'invalid' });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test.each([0, 150])('bounds typed 429 retries to the %i ms Code API budget', async (budget) => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest.fn().mockImplementation(
        () =>
          new Response(JSON.stringify({ error: 'rate_limited', retry_after_seconds: 0 }), {
            status: 429,
            headers: { 'Retry-After': '0' },
          }),
      );
      const result = executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        codeApiMaxRetryWaitMs: budget,
        request: { protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'x' },
      }).catch((error: WorkspaceToolHttpError) => error);

      await jest.advanceTimersByTimeAsync(budget);
      await expect(result).resolves.toMatchObject({
        upstreamStatus: 429,
        message: expect.stringContaining('The operation was not started'),
      });
      expect(fetchImpl).toHaveBeenCalledTimes(budget === 0 ? 1 : 2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('does not wait when a 429 retry hint exceeds the Code API budget', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate_limited', retry_after_seconds: 30 }), {
        status: 429,
      }),
    );
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        request: { protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'x' },
      }),
    ).rejects.toMatchObject({ upstreamStatus: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('keeps queue retries enabled when Code API rate-limit retries are disabled', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ code: 'WORKSPACE_QUEUE_TIMEOUT' }), {
            status: 503,
            headers: { 'Retry-After': '0' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }),
        );
      const result = executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        codeApiMaxRetryWaitMs: 0,
        request: { protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'x' },
      }).catch((error: WorkspaceToolHttpError) => error);

      await jest.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toMatchObject({ upstreamStatus: 429 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('does not charge queue waits to the Code API rate-limit budget', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'rate_limited' }), {
            status: 429,
            headers: { 'Retry-After': '0' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ code: 'WORKSPACE_QUEUE_TIMEOUT' }), {
            status: 503,
            headers: { 'Retry-After': '0' },
          }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 504 }));
      const result = executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        codeApiMaxRetryWaitMs: 100,
        request: { protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'x' },
      }).catch((error: WorkspaceToolHttpError) => error);

      await jest.advanceTimersByTimeAsync(200);
      await expect(result).resolves.toMatchObject({ upstreamStatus: 504 });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([0, 50])(
    'retries typed 429s after a %i ms queue horizon without re-enabling capacity retries',
    async (maxQueueWaitMs) => {
      jest.useFakeTimers();
      try {
        const fetchImpl = jest
          .fn()
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ error: 'rate_limited' }), {
              status: 429,
              headers: { 'Retry-After': '0' },
            }),
          )
          .mockResolvedValueOnce(new Response('{}', { status: 504 }));
        const result = executeWorkspaceTool({
          baseURL: 'https://code.example/v1',
          authHeaders: {},
          fetchImpl,
          maxQueueWaitMs,
          codeApiMaxRetryWaitMs: 100,
          request: {
            protocolVersion: 1,
            operation: 'read_file',
            workspaceId: 'primary',
            path: 'x',
          },
        }).catch((error: WorkspaceToolHttpError) => error);

        await jest.advanceTimersByTimeAsync(100);
        await expect(result).resolves.toMatchObject({ upstreamStatus: 504 });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  test('continues 429 recovery after a queue retry but never extends its capacity horizon', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ code: 'WORKSPACE_QUEUE_TIMEOUT' }), {
            status: 503,
            headers: { 'Retry-After': '0' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'rate_limited' }), {
            status: 429,
            headers: { 'Retry-After': '0' },
          }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 504 }));
      const result = executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        maxQueueWaitMs: 150,
        codeApiMaxRetryWaitMs: 100,
        request: { protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'x' },
      }).catch((error: WorkspaceToolHttpError) => error);

      await jest.advanceTimersByTimeAsync(200);
      await expect(result).resolves.toMatchObject({ upstreamStatus: 504 });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test('never borrows the rate-limit horizon to retry a later capacity timeout', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'rate_limited' }), {
            status: 429,
            headers: { 'Retry-After': '0' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ code: 'WORKSPACE_QUEUE_TIMEOUT' }), {
            status: 503,
            headers: { 'Retry-After': '0' },
          }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 504 }));
      const result = executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        maxQueueWaitMs: 50,
        codeApiMaxRetryWaitMs: 200,
        request: { protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'x' },
      }).catch((error: WorkspaceToolHttpError) => error);

      await jest.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toMatchObject({ upstreamStatus: 503 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('retries after an authorized rate-limit wait despite timer jitter', async () => {
    jest.useFakeTimers();
    const startedAt = Date.now();
    let currentTime = startedAt;
    jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
    try {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'rate_limited' }), {
            status: 429,
            headers: { 'Retry-After': '0' },
          }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 504 }));
      const result = executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        maxQueueWaitMs: 0,
        codeApiMaxRetryWaitMs: 100,
        request: { protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'x' },
      }).catch((error: WorkspaceToolHttpError) => error);

      await jest.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      currentTime += 101;
      await jest.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toMatchObject({ upstreamStatus: 504 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('charges an overslept 429 wait before considering another retry', async () => {
    jest.useFakeTimers();
    const startedAt = Date.now();
    let currentTime = startedAt;
    jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
    try {
      const rateLimited = () =>
        new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(rateLimited())
        .mockResolvedValueOnce(rateLimited())
        .mockResolvedValueOnce(new Response('{}', { status: 504 }));
      const result = executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        maxQueueWaitMs: 0,
        codeApiMaxRetryWaitMs: 200,
        request: { protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'x' },
      }).catch((error: WorkspaceToolHttpError) => error);

      await jest.advanceTimersByTimeAsync(0);
      currentTime += 150;
      await jest.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toMatchObject({ upstreamStatus: 429 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('reserves the caller HTTP execution budget when capacity retries are disabled', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: { 'Retry-After': '0' },
        }),
      );
      const result = executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        maxQueueWaitMs: 0,
        codeApiMaxRetryWaitMs: 1_000,
        maxRequestTimeoutMs: 35_050,
        request: { protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'x' },
      }).catch((error: WorkspaceToolHttpError) => error);

      await jest.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toMatchObject({ upstreamStatus: 429 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('reports a rate limit as not started when its retry budget is disabled', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate_limited', retry_after_seconds: 1 }), {
        status: 429,
        headers: { 'Retry-After': '1' },
      }),
    );

    const failure = executeWorkspaceTool({
      baseURL: 'https://code.example/v1',
      authHeaders: {},
      fetchImpl,
      codeApiMaxRetryWaitMs: 0,
      request: {
        protocolVersion: 1,
        operation: 'execute_command',
        workspaceId: 'primary',
        command: 'echo test',
      },
    });

    await expect(failure).rejects.toThrow('The operation was not started');
    await expect(failure).rejects.toMatchObject({ upstreamStatus: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('never retries a 429 that does not carry the typed rate-limit body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response('<html>Too Many Requests</html>', {
        status: 429,
        headers: { 'Retry-After': '0' },
      }),
    );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        request: {
          protocolVersion: 1,
          operation: 'edit_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
          edits: [{ oldText: 'const old = true;', newText: 'const ready = true;' }],
        },
      }),
    ).rejects.toMatchObject({ upstreamStatus: 429 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('never retries an ambiguous capacity-looking failure', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response('<html>Gateway unavailable</html>', {
        status: 503,
        headers: { 'Retry-After': '0' },
      }),
    );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example/v1',
        authHeaders: {},
        fetchImpl,
        request: {
          protocolVersion: 1,
          operation: 'edit_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
          edits: [{ oldText: 'const old = true;', newText: 'const ready = true;' }],
        },
      }),
    ).rejects.toMatchObject({ upstreamStatus: 503 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([
    [504, '{"code":"ASSIGNMENT_EXPIRED"}', false],
    [503, '<html>Gateway unavailable</html>', false],
    [503, '{"code":"WORKSPACE_QUEUE_TIMEOUT"}', true],
    [503, 'null', false],
    [503, '{"error":"rate_limited"}', false],
    [429, '{"code":"WORKSPACE_QUEUE_TIMEOUT"}', false],
    [429, '{"error":"rate_limited"}', true],
    [429, '<html>Too Many Requests</html>', false],
  ] as const)(
    'does not infer non-execution from an ambiguous response',
    (status, body, truncated) => {
      expect(new WorkspaceToolHttpError('rejected', status, body, truncated).message).not.toContain(
        'not started',
      );
    },
  );
});

describe('executeWorkspaceTool', () => {
  test.each([0, 100])(
    'preserves admitted command execution beyond a %i ms retry horizon',
    async (maxQueueWaitMs) => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
      const timeout = jest.spyOn(AbortSignal, 'timeout');
      const fetchImpl = jest.fn(async (...[_url, init]: Parameters<CodeBridgeFetch>) => {
        // The endpoint does not report admission separately. A successful command
        // may finish after the client retry horizon without being cancelled.
        now.mockReturnValue(2000);
        expect(init?.signal?.aborted).toBe(false);
        return new Response(
          JSON.stringify({
            protocolVersion: 1,
            operation: 'execute_command',
            workspaceId: 'primary',
            stdout: 'ready',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            truncated: false,
          }),
          { status: 200 },
        );
      });
      await expect(
        executeWorkspaceTool({
          baseURL: 'https://code.example/v1',
          authHeaders: {},
          maxQueueWaitMs,
          fetchImpl,
          request: {
            protocolVersion: 1,
            operation: 'execute_command',
            workspaceId: 'primary',
            command: 'echo ready',
            timeoutMs: 300000,
          },
        }),
      ).resolves.toMatchObject({ stdout: 'ready', exitCode: 0 });
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(340000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  test.each<[WorkspaceToolRequest, number]>([
    [
      { protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'README.md' },
      65_000,
    ],
    [
      {
        protocolVersion: 1,
        operation: 'execute_command',
        workspaceId: 'primary',
        command: 'echo ready',
      },
      70_000,
    ],
    [
      {
        protocolVersion: 1,
        operation: 'execute_command',
        workspaceId: 'primary',
        command: 'echo ready',
        timeoutMs: 300_000,
      },
      340_000,
    ],
  ])('allows admission, execution and delivery time for %j', async (request, budget) => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'Older server deadline exceeded', code: 'ASSIGNMENT_EXPIRED' }),
          { status: 504 },
        ),
      );
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: {},
        request,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ upstreamStatus: 504 });
    expect(timeout).toHaveBeenCalledWith(budget);
    expect(fetchImpl.mock.calls[0][1].body).toBe(JSON.stringify(request));
    const admissionMs = Number(
      fetchImpl.mock.calls[0][1].headers['X-LibreChat-Workspace-Queue-Wait-Ms'],
    );
    expect(admissionMs).toBeGreaterThan(0);
    expect(admissionMs).toBeLessThanOrEqual(30_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each<[WorkspaceToolRequest, number, number]>([
    [
      { protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'README.md' },
      125_000,
      90_000,
    ],
    [
      { protocolVersion: 1, operation: 'execute_command', workspaceId: 'primary', command: 'pwd' },
      125_000,
      85_000,
    ],
    [
      {
        protocolVersion: 1,
        operation: 'execute_command',
        workspaceId: 'primary',
        command: 'pwd',
        timeoutMs: 90_000,
      },
      125_000,
      25_000,
    ],
    [
      { protocolVersion: 1, operation: 'read_file', workspaceId: 'primary', path: 'README.md' },
      60_000,
      25_000,
    ],
    [
      { protocolVersion: 1, operation: 'execute_command', workspaceId: 'primary', command: 'pwd' },
      60_000,
      20_000,
    ],
    [
      {
        protocolVersion: 1,
        operation: 'execute_command',
        workspaceId: 'primary',
        command: 'pwd',
        timeoutMs: 300_000,
      },
      610_000,
      300_000,
    ],
  ])(
    'advertises only the remaining queue time for %j under a %i ms limit',
    async (request, maxRequestTimeoutMs, allowanceMs) => {
      jest.spyOn(Date, 'now').mockReturnValue(1_000);
      const timeout = jest.spyOn(AbortSignal, 'timeout');
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: 'ASSIGNMENT_EXPIRED' }), { status: 504 }),
        );
      await expect(
        executeWorkspaceTool({
          baseURL: 'https://code.example.com/v1',
          authHeaders: {},
          request,
          maxRequestTimeoutMs,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ upstreamStatus: 504 });
      expect(timeout).toHaveBeenCalledWith(maxRequestTimeoutMs);
      expect(fetchImpl.mock.calls[0][1].headers['X-LibreChat-Workspace-Queue-Wait-Ms']).toBe(
        String(allowanceMs),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  test('accepts a result after 31 simulated seconds of admission with an explicit longer budget', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const fetchImpl: CodeBridgeFetch = jest.fn(async (_url, init) => {
      expect((init?.headers as Record<string, string>)['X-LibreChat-Workspace-Queue-Wait-Ms']).toBe(
        '90000',
      );
      now.mockReturnValue(32_000);
      expect(init?.signal?.aborted).toBe(false);
      return Response.json({
        protocolVersion: 1,
        operation: 'read_file',
        workspaceId: 'primary',
        path: 'README.md',
        content: 'ready',
        startLine: 1,
        endLine: 1,
        truncated: false,
      });
    });
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: {},
        request: {
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: 'README.md',
        },
        maxRequestTimeoutMs: 125_000,
        fetchImpl,
      }),
    ).resolves.toMatchObject({ content: 'ready' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('uses the earlier caller deadline rather than assuming the abort signal reveals it', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const fetchImpl = jest.fn().mockResolvedValue(new Response('{}', { status: 504 }));
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: {},
        request: {
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: 'README.md',
        },
        maxRequestTimeoutMs: 125_000,
        deadlineAtMs: 61_000,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ upstreamStatus: 504 });
    expect(timeout).toHaveBeenCalledWith(60_000);
    expect(fetchImpl.mock.calls[0][1].headers['X-LibreChat-Workspace-Queue-Wait-Ms']).toBe('25000');
  });

  test('subtracts credential acquisition from the allowance before dispatching', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const fetchImpl = jest.fn().mockResolvedValue(new Response('{}', { status: 504 }));
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: async () => {
          now.mockReturnValue(20_000);
          return {};
        },
        request: {
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: 'README.md',
        },
        maxRequestTimeoutMs: 125_000,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ upstreamStatus: 504 });
    expect(fetchImpl.mock.calls[0][1].headers['X-LibreChat-Workspace-Queue-Wait-Ms']).toBe('71000');
  });

  test.each<[WorkspaceToolRequest, number]>([
    [
      {
        protocolVersion: 1,
        operation: 'execute_command',
        workspaceId: 'primary',
        command: 'pwd',
        timeoutMs: 300_000,
      },
      125_000,
    ],
    [
      {
        protocolVersion: 1,
        operation: 'execute_command',
        workspaceId: 'primary',
        command: 'pwd',
        timeoutMs: 90_000,
      },
      60_000,
    ],
  ])(
    'does not dispatch when %j cannot fit within the %i ms ingress limit',
    async (request, maxRequestTimeoutMs) => {
      const fetchImpl = jest.fn();
      await expect(
        executeWorkspaceTool({
          baseURL: 'https://code.example.com/v1',
          authHeaders: {},
          request,
          maxRequestTimeoutMs,
          fetchImpl,
        }),
      ).rejects.toMatchObject({
        reason: 'insufficient_time',
        message: expect.stringContaining('not started'),
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test('keeps the retry horizon separate from one longer admission attempt', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 'WORKSPACE_QUEUE_TIMEOUT' }), { status: 503 }),
      );
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: {},
        request: {
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: 'README.md',
        },
        maxRequestTimeoutMs: 125_000,
        maxQueueWaitMs: 0,
        fetchImpl,
      }),
    ).rejects.toThrow('The operation was not started');
    expect(fetchImpl.mock.calls[0][1].headers['X-LibreChat-Workspace-Queue-Wait-Ms']).toBe('90000');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('keeps Retry-After capped at 30 seconds even when one admission may wait longer', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ code: 'WORKSPACE_QUEUE_TIMEOUT' }), {
            status: 503,
            headers: { 'Retry-After': '300' },
          }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 504 }));
      const result = executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: {},
        request: {
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: 'README.md',
        },
        maxRequestTimeoutMs: 125_000,
        fetchImpl,
      }).catch((error: WorkspaceToolHttpError) => error);
      await jest.advanceTimersByTimeAsync(29_999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ upstreamStatus: 504 });
      expect(fetchImpl.mock.calls[1][1].headers['X-LibreChat-Workspace-Queue-Wait-Ms']).toBe(
        '60000',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test('never retries a post-dispatch timeout with an unknown mutation outcome', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new DOMException('response deadline', 'TimeoutError'));
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: {},
        request: {
          protocolVersion: 1,
          operation: 'execute_command',
          workspaceId: 'primary',
          command: 'touch marker',
        },
        maxRequestTimeoutMs: 125_000,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'timeout' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('sends an authenticated bounded read to the selected attached worker', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
          content: 'const ready = true;',
          startLine: 1,
          endLine: 1,
          truncated: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1/',
        authHeaders: {
          Authorization: 'Bearer jwt',
          'X-LibreChat-Code-Worker-ID': 'user-worker',
        },
        request: {
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
          startLine: 1,
          maxLines: 200,
        },
        fetchImpl,
      }),
    ).resolves.toMatchObject({ content: 'const ready = true;' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://code.example.com/v1/workspace-tools/execute',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt',
          'Content-Type': 'application/json',
          'X-LibreChat-Code-Worker-ID': 'user-worker',
        }),
      }),
    );
  });

  test('combines the caller abort signal with the workspace request timeout', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetchImpl: CodeBridgeFetch = jest.fn(async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(
        JSON.stringify({
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: 'notes.txt',
          content: 'ready',
          startLine: 1,
          endLine: 1,
          truncated: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    await executeWorkspaceTool({
      baseURL: 'https://code.example.com/v1',
      authHeaders: { Authorization: 'Bearer jwt' },
      signal: controller.signal,
      request: {
        protocolVersion: 1,
        operation: 'read_file',
        workspaceId: 'primary',
        path: 'notes.txt',
      },
      fetchImpl,
    });

    expect(requestSignal?.aborted).toBe(false);
    controller.abort();
    expect(requestSignal?.aborted).toBe(true);
  });

  test('preserves caller cancellation instead of relabeling it as a transport failure', async () => {
    const controller = new AbortController();
    const fetchImpl: CodeBridgeFetch = jest.fn(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );

    const request = executeWorkspaceTool({
      baseURL: 'https://code.example.com/v1',
      authHeaders: { Authorization: 'Bearer jwt' },
      signal: controller.signal,
      request: {
        protocolVersion: 1,
        operation: 'read_file',
        workspaceId: 'primary',
        path: 'notes.txt',
      },
      fetchImpl,
    });
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('preserves caller cancellation while reading the response body', async () => {
    const controller = new AbortController();
    const fetchImpl: CodeBridgeFetch = jest.fn(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          init?.signal?.addEventListener(
            'abort',
            () => streamController.error(init.signal?.reason),
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const request = executeWorkspaceTool({
      baseURL: 'https://code.example.com/v1',
      authHeaders: { Authorization: 'Bearer jwt' },
      signal: controller.signal,
      request: {
        protocolVersion: 1,
        operation: 'read_file',
        workspaceId: 'primary',
        path: 'notes.txt',
      },
      fetchImpl,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('rejects a malformed worker result before it reaches the model', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: '/Users/operator/.ssh/id_ed25519',
          content: 'secret',
          startLine: 1,
          endLine: 1,
          truncated: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: { Authorization: 'Bearer jwt' },
        request: {
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });

  test.each(['./src/app.ts', 'src/./app.ts', 'src//app.ts'])(
    'rejects the non-canonical request path %s before dispatch',
    async (path) => {
      const fetchImpl = jest.fn();

      await expect(
        executeWorkspaceTool({
          baseURL: 'https://code.example.com/v1',
          authHeaders: { Authorization: 'Bearer jwt' },
          request: {
            protocolVersion: 1,
            operation: 'read_file',
            workspaceId: 'primary',
            path,
          },
          fetchImpl,
        }),
      ).rejects.toMatchObject({ reason: 'invalid' });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test('rejects read content that exceeds its declared line range', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
          content: 'first\nsecond',
          startLine: 1,
          endLine: 1,
          truncated: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: { Authorization: 'Bearer jwt' },
        request: {
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
          maxLines: 1,
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });

  test('rejects unexpected result fields that could disclose worker metadata', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
          content: 'safe',
          startLine: 1,
          endLine: 1,
          truncated: false,
          root: '/Users/operator/private',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: { Authorization: 'Bearer jwt' },
        request: {
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });

  test('preserves the upstream status when the error body stalls', async () => {
    const cancel = jest.fn();
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          cancel,
        }),
        { status: 503 },
      ),
    );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: { Authorization: 'Bearer jwt' },
        request: {
          protocolVersion: 1,
          operation: 'search_text',
          workspaceId: 'primary',
          query: 'needle',
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      reason: 'rejected',
      upstreamStatus: 503,
      upstreamBodyTruncated: true,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test.each([400, 409, 503, 504])('preserves HTTP %i and its diagnostic body', async (status) => {
    const body = JSON.stringify({ code: 'ASSIGNMENT_EXPIRED', error: 'Assignment expired' });
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com',
        authHeaders: {},
        request: { protocolVersion: 1, operation: 'list_files', workspaceId: 'primary' },
        fetchImpl: jest.fn(async () => new Response(body, { status })),
      }),
    ).rejects.toMatchObject({
      reason: 'rejected',
      upstreamStatus: status,
      upstreamBody: body,
      upstreamBodyTruncated: false,
      message: expect.stringContaining(`upstreamStatus: ${status}`),
    });
  });

  test.each([4095, 4096, 4097])(
    'reports truncation correctly for a %i-byte error body',
    async (size) => {
      await expect(
        executeWorkspaceTool({
          baseURL: 'https://code.example.com',
          authHeaders: {},
          request: { protocolVersion: 1, operation: 'list_files', workspaceId: 'primary' },
          fetchImpl: jest.fn(async () => new Response('x'.repeat(size), { status: 503 })),
        }),
      ).rejects.toMatchObject({
        upstreamStatus: 503,
        upstreamBody: 'x'.repeat(Math.min(size, 4096)),
        upstreamBodyTruncated: size > 4096,
      });
    },
  );

  test('preserves caller cancellation during a rejected response body read', async () => {
    const controller = new AbortController();
    const cancel = jest.fn();
    const request = executeWorkspaceTool({
      baseURL: 'https://code.example.com',
      authHeaders: {},
      signal: controller.signal,
      request: { protocolVersion: 1, operation: 'list_files', workspaceId: 'primary' },
      fetchImpl: jest.fn(async () => new Response(new ReadableStream({ cancel }), { status: 503 })),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(request).rejects.toBe(controller.signal.reason);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('bounds a streaming error body and cancels the unread remainder', async () => {
    const cancel = jest.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(10_000)));
      },
      cancel,
    });
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com',
        authHeaders: {},
        request: { protocolVersion: 1, operation: 'list_files', workspaceId: 'primary' },
        fetchImpl: jest.fn(async () => new Response(body, { status: 504 })),
      }),
    ).rejects.toMatchObject({
      upstreamStatus: 504,
      upstreamBody: 'x'.repeat(4096),
      upstreamBodyTruncated: true,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('retains HTTP status when reading the error body fails', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('socket closed'));
      },
    });
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com',
        authHeaders: {},
        request: { protocolVersion: 1, operation: 'list_files', workspaceId: 'primary' },
        fetchImpl: jest.fn(async () => new Response(body, { status: 503 })),
      }),
    ).rejects.toMatchObject({ upstreamStatus: 503, upstreamBodyTruncated: true });
  });

  test('validates bounded search matches before returning them', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          operation: 'search_text',
          workspaceId: 'primary',
          matches: [
            {
              path: 'src/app.ts',
              line: 7,
              column: 3,
              text: 'const needle = true;',
              hostRoot: '/Users/operator/private',
            },
          ],
          truncated: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: { Authorization: 'Bearer jwt' },
        request: {
          protocolVersion: 1,
          operation: 'search_text',
          workspaceId: 'primary',
          query: 'needle',
          maxResults: 20,
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });

  test('rejects non-canonical dot-segment request paths before dispatch', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      Response.json({
        protocolVersion: 1,
        operation: 'search_text',
        workspaceId: 'primary',
        matches: [{ path: 'src/app.ts', line: 1, column: 1, text: 'needle' }],
        truncated: false,
      }),
    );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: { Authorization: 'Bearer jwt' },
        request: {
          protocolVersion: 1,
          operation: 'search_text',
          workspaceId: 'primary',
          query: 'needle',
          path: './src',
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('validates bounded file listings within the requested subtree', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      Response.json({
        protocolVersion: 1,
        operation: 'list_files',
        workspaceId: 'primary',
        paths: ['src/app.ts', 'src/worker.ts'],
        truncated: true,
        nextAfterPath: 'src/worker.ts',
      }),
    );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: { Authorization: 'Bearer jwt' },
        request: {
          protocolVersion: 1,
          operation: 'list_files',
          workspaceId: 'primary',
          path: 'src',
          afterPath: 'src/000.ts',
          maxResults: 20,
        },
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      paths: ['src/app.ts', 'src/worker.ts'],
      nextAfterPath: 'src/worker.ts',
    });

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: { Authorization: 'Bearer jwt' },
        request: {
          protocolVersion: 1,
          operation: 'list_files',
          workspaceId: 'primary',
          path: './src',
          maxResults: 20,
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    fetchImpl.mockResolvedValueOnce(
      Response.json({
        protocolVersion: 1,
        operation: 'list_files',
        workspaceId: 'primary',
        paths: ['outside.txt'],
        truncated: false,
      }),
    );
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: { Authorization: 'Bearer jwt' },
        request: {
          protocolVersion: 1,
          operation: 'list_files',
          workspaceId: 'primary',
          path: 'src',
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });

  test('rejects newline-delimited paths returned by an attached worker', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      Response.json({
        protocolVersion: 1,
        operation: 'list_files',
        workspaceId: 'primary',
        paths: ['src/safe.ts\nworkspace/src/injected.ts'],
        truncated: false,
      }),
    );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: { Authorization: 'Bearer jwt' },
        request: {
          protocolVersion: 1,
          operation: 'list_files',
          workspaceId: 'primary',
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });

  test('rejects invalid workspace listing continuations on both sides of the bridge', async () => {
    const fetchImpl = jest.fn();
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: { Authorization: 'Bearer jwt' },
        request: {
          protocolVersion: 1,
          operation: 'list_files',
          workspaceId: 'primary',
          path: 'src',
          afterPath: 'outside/file.ts',
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();

    fetchImpl.mockResolvedValueOnce(
      Response.json({
        protocolVersion: 1,
        operation: 'list_files',
        workspaceId: 'primary',
        paths: ['src/worker.ts'],
        truncated: true,
      }),
    );
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: { Authorization: 'Bearer jwt' },
        request: {
          protocolVersion: 1,
          operation: 'list_files',
          workspaceId: 'primary',
          path: 'src',
          afterPath: 'src/app.ts',
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });

  test('rejects an oversized response before parsing worker-controlled JSON', async () => {
    const cancel = jest.fn();
    const json = jest.fn().mockResolvedValue({
      protocolVersion: 1,
      operation: 'read_file',
      workspaceId: 'primary',
      path: 'src/app.ts',
      content: 'safe',
      startLine: 1,
      endLine: 1,
      truncated: false,
    });
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Length': String(5 * 1024 * 1024) }),
      body: new ReadableStream({ cancel }),
      json,
    } as unknown as Response);

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: { Authorization: 'Bearer jwt' },
        request: {
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
    expect(json).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('rejects unrecognized workspace operations before dispatch', async () => {
    const fetchImpl = jest.fn();

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: { Authorization: 'Bearer jwt' },
        request: {
          protocolVersion: 1,
          operation: 'delete_file',
          workspaceId: 'primary',
          query: 'ignored',
        } as never,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('accepts a bounded command result from the selected attached worker', async () => {
    const fetchImpl = jest.fn(async () =>
      Response.json({
        protocolVersion: 1,
        operation: 'execute_command',
        workspaceId: 'primary',
        exitCode: 2,
        stdout: '',
        stderr: 'not found',
        truncated: false,
        timedOut: false,
      }),
    );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: { Authorization: 'Bearer jwt' },
        request: {
          protocolVersion: 1,
          operation: 'execute_command',
          workspaceId: 'primary',
          command: 'test -f package.json',
          maxOutputBytes: 256 * 1024,
        },
        fetchImpl,
      }),
    ).resolves.toMatchObject({ exitCode: 2, stderr: 'not found' });
  });

  test('rejects command requests and results outside protocol limits', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () =>
      Response.json({
        protocolVersion: 1,
        operation: 'execute_command',
        workspaceId: 'primary',
        exitCode: 0,
        stdout: 'x'.repeat(9),
        stderr: '',
        truncated: false,
        timedOut: false,
      }),
    );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: {},
        request: {
          protocolVersion: 1,
          operation: 'execute_command',
          workspaceId: 'primary',
          command: 'printf x',
          maxOutputBytes: 8,
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: {},
        request: {
          protocolVersion: 1,
          operation: 'execute_command',
          workspaceId: 'primary',
          command: 'x'.repeat(32 * 1024 + 1),
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });

  test('validates atomic create-only workspace writes', async () => {
    const fetchImpl = jest.fn(async () =>
      Response.json({
        protocolVersion: 1,
        operation: 'write_file',
        workspaceId: 'primary',
        path: 'src/new.ts',
        created: true,
        bytesWritten: 5,
      }),
    );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: { Authorization: 'Bearer jwt' },
        request: {
          protocolVersion: 1,
          operation: 'write_file',
          workspaceId: 'primary',
          path: 'src/new.ts',
          content: 'ready',
          overwrite: false,
        },
        fetchImpl,
      }),
    ).resolves.toMatchObject({ created: true, bytesWritten: 5 });

    fetchImpl.mockResolvedValueOnce(
      Response.json({
        protocolVersion: 1,
        operation: 'write_file',
        workspaceId: 'primary',
        path: 'src/new.ts',
        created: false,
        bytesWritten: 5,
      }),
    );
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: {},
        request: {
          protocolVersion: 1,
          operation: 'write_file',
          workspaceId: 'primary',
          path: 'src/new.ts',
          content: 'ready',
          overwrite: false,
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });

  test('validates bounded atomic workspace edit batches', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () =>
      Response.json({
        protocolVersion: 1,
        operation: 'edit_file',
        workspaceId: 'primary',
        path: 'src/app.ts',
        replacements: 2,
        bytesWritten: 18,
      }),
    );
    const request = {
      protocolVersion: 1 as const,
      operation: 'edit_file' as const,
      workspaceId: 'primary',
      path: 'src/app.ts',
      edits: [
        { oldText: 'false', newText: 'true' },
        { oldText: 'draft', newText: 'ready' },
      ],
    };

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: {},
        request,
        fetchImpl,
      }),
    ).resolves.toMatchObject({ replacements: 2 });

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: {},
        request: { ...request, edits: [] },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: {},
        request: { ...request, edits: undefined } as unknown as typeof request,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('validates exact edit previews and revision-fenced commits', async () => {
    const edits = [{ oldText: ' suffix', newText: 'RET suffix' }];
    const baseSha256 = 'a'.repeat(64);
    const fetchImpl: CodeBridgeFetch = jest
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          protocolVersion: 1,
          operation: 'preview_edit',
          workspaceId: 'primary',
          path: 'src/app.ts',
          content: 'prefix SECRET suffix',
          hasUtf8Bom: false,
          baseSha256,
          replacements: 1,
          bytesWritten: 20,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          protocolVersion: 1,
          operation: 'edit_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
          replacements: 1,
          bytesWritten: 20,
        }),
      );

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: {},
        request: {
          protocolVersion: 1,
          operation: 'preview_edit',
          workspaceId: 'primary',
          path: 'src/app.ts',
          edits,
        },
        fetchImpl,
      }),
    ).resolves.toMatchObject({ content: 'prefix SECRET suffix', baseSha256 });

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: {},
        request: {
          protocolVersion: 1,
          operation: 'edit_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
          edits,
          expectedBaseSha256: baseSha256,
        },
        fetchImpl,
      }),
    ).resolves.toMatchObject({ replacements: 1 });

    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example.com/v1',
        authHeaders: {},
        request: {
          protocolVersion: 1,
          operation: 'edit_file',
          workspaceId: 'primary',
          path: 'src/app.ts',
          edits,
          expectedBaseSha256: 'invalid',
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

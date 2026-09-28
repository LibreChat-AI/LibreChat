import {
  CodeBridgeStatusError,
  createCodeBridgeStatusPoller,
  getCodeBridgeWorkerStatus,
} from './bridge';

describe('getCodeBridgeWorkerStatus', () => {
  test.each([
    [['bash'], ['bash']],
    [['bash', 'python'], ['bash']],
    [['python'], undefined],
    [['bash', 123], undefined],
  ])(
    'preserves recognized programmatic capability from %j',
    async (programmaticLanguages, expected) => {
      const status = await getCodeBridgeWorkerStatus({
        baseURL: 'https://code.example.com/v1',
        token: 'token',
        workerId: 'personal-vm',
        fetchImpl: jest.fn().mockResolvedValue(
          Response.json({
            protocolVersion: 1,
            workerId: 'personal-vm',
            online: true,
            ready: true,
            leaseExpiresInMs: 45_000,
            capabilities: {
              statefulWorkspace: false,
              runtimes: [],
              sandboxProfile: 'native-srt',
              workspaceTools: {
                protocolVersion: 1,
                operations: ['execute_command'],
                workspaces: [{ id: 'project-a' }],
                programmaticLanguages,
              },
            },
          }),
        ),
      });
      expect(status.programmaticLanguages).toEqual(expected);
    },
  );
  test('accepts the maximum declared environment metadata population', async () => {
    const workspaces = Array.from({ length: 32 }, (_, index) => ({
      id: `root-${index}`,
      name: 'n'.repeat(128),
      environment: {
        fingerprint: 'a'.repeat(64),
        repo: `a/${'b'.repeat(254)}`,
        ref: '\t'.repeat(255) + 'x',
        actions: Array.from({ length: 32 }, (_, action) => `${action}${'a'.repeat(62)}`),
      },
    }));
    const payload = {
      protocolVersion: 1,
      workerId: 'personal-vm',
      online: true,
      ready: true,
      leaseExpiresInMs: 45000,
      capabilities: {
        statefulWorkspace: false,
        sandboxProfile: 'native-srt',
        runtimes: [],
        workspaceTools: { protocolVersion: 1, operations: ['execute_command'], workspaces },
      },
    };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(64 * 1024);
    await expect(
      getCodeBridgeWorkerStatus({
        baseURL: 'https://code.example.com/v1',
        token: 'token',
        workerId: 'personal-vm',
        fetchImpl: jest.fn().mockResolvedValue(Response.json(payload)),
      }),
    ).resolves.toMatchObject({ status: 'ready', workspaces });
  });
  test('normalizes a ready worker while exposing only bounded capability metadata', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          workerId: 'personal-vm',
          online: true,
          ready: true,
          leaseExpiresInMs: 45_000,
          maxCommandTimeoutMs: 120_000,
          capabilities: {
            statefulWorkspace: true,
            sandboxProfile: 'native-srt',
            runtimes: ['bash'],
            workspaceTools: {
              protocolVersion: 1,
              operations: ['read_file', 'execute_command'],
              workspaces: [
                {
                  id: 'project-a',
                  name: 'Project A',
                  workspaceInstances: ['git_worktree'],
                },
                { id: 'docs', operations: ['read_file'] },
              ],
            },
            identityId: 'must-not-cross-the-boundary',
          },
          binding: { tenantId: 'tenant-1', principal: { type: 'user', id: 'user-1' } },
        }),
      ),
    );

    await expect(
      getCodeBridgeWorkerStatus({
        baseURL: 'https://code.example.com/v1/',
        token: 'administrator-token',
        workerId: 'personal-vm',
        fetchImpl,
      }),
    ).resolves.toEqual({
      status: 'ready',
      statefulWorkspace: true,
      leaseExpiresInMs: 45_000,
      maxCommandTimeoutMs: 120_000,
      sandboxProfile: 'native-srt',
      runtimes: ['bash'],
      operations: ['read_file', 'execute_command'],
      workspaces: [
        {
          id: 'project-a',
          name: 'Project A',
          workspaceInstances: ['git_worktree'],
        },
        { id: 'docs', operations: ['read_file'] },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://code.example.com/v1/bridge/workers/personal-vm/status',
      expect.objectContaining({
        headers: { Authorization: 'Bearer administrator-token' },
        redirect: 'error',
      }),
    );
  });

  test('keeps legacy worker status readable without inventing a primary workspace', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          workerId: 'personal-vm',
          online: true,
          ready: true,
          leaseExpiresInMs: 45_000,
          capabilities: {
            statefulWorkspace: true,
            sandboxProfile: 'native-srt',
            runtimes: ['bash'],
            workspaceTools: { operations: ['read_file', 'execute_command'] },
          },
        }),
      ),
    );

    await expect(
      getCodeBridgeWorkerStatus({
        baseURL: 'https://code.example.com/v1',
        token: 'administrator-token',
        workerId: 'personal-vm',
        fetchImpl,
      }),
    ).resolves.toEqual({
      status: 'ready',
      statefulWorkspace: true,
      leaseExpiresInMs: 45_000,
      sandboxProfile: 'native-srt',
      runtimes: ['bash'],
      operations: ['read_file', 'execute_command'],
    });
  });

  test.each([
    { online: false, ready: true },
    { online: true, ready: false },
    { online: false, ready: false, leaseExpiresInMs: 5_000 },
    { online: true, ready: true, leaseExpiresInMs: 60_001 },
    { online: true, ready: true, maxCommandTimeoutMs: 0 },
    { online: true, ready: true, maxCommandTimeoutMs: 300_001 },
    {
      online: true,
      ready: true,
      capabilities: { sandboxProfile: 'native-srt', runtimes: Array(33).fill('bash') },
    },
    {
      online: true,
      ready: true,
      leaseExpiresInMs: 5_000,
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'native-srt',
        runtimes: ['bash'],
        workspaceTools: {
          protocolVersion: 1,
          operations: ['read_file'],
          workspaces: [{ id: '../escape' }],
        },
      },
    },
    {
      online: true,
      ready: true,
      leaseExpiresInMs: 5_000,
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'native-srt',
        runtimes: ['bash'],
        workspaceTools: {
          protocolVersion: 1,
          operations: ['read_file'],
          workspaces: [{ id: 'project-a', workspaceInstances: ['container'] }],
        },
      },
    },
    {
      online: true,
      ready: true,
      leaseExpiresInMs: 5_000,
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'native-srt',
        runtimes: ['bash'],
        workspaceTools: {
          protocolVersion: 1,
          operations: ['read_file'],
          workspaces: [{ id: 'project-a', operations: ['execute_command'] }],
        },
      },
    },
    {
      online: true,
      ready: true,
      leaseExpiresInMs: 5_000,
      capabilities: {
        statefulWorkspace: true,
        sandboxProfile: 'native-srt',
        runtimes: ['bash'],
        workspaceTools: {
          protocolVersion: 1,
          operations: ['read_file'],
          workspaces: [{ id: 'project-a', operations: null }],
        },
      },
    },
  ])('rejects an invalid upstream status response: %p', async (invalid) => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ protocolVersion: 1, workerId: 'personal-vm', ...invalid })),
      );

    await expect(
      getCodeBridgeWorkerStatus({
        baseURL: 'https://code.example.com/v1',
        token: 'administrator-token',
        workerId: 'personal-vm',
        fetchImpl,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CodeBridgeStatusError>>({ reason: 'invalid' }),
    );
  });

  test('rejects an upstream response before buffering more than 256 KiB', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ignored: 'x'.repeat(257 * 1024) })));

    await expect(
      getCodeBridgeWorkerStatus({
        baseURL: 'https://code.example.com/v1',
        token: 'administrator-token',
        workerId: 'personal-vm',
        fetchImpl,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CodeBridgeStatusError>>({ reason: 'invalid' }),
    );
  });

  test('coalesces matching polls and rejects excess distinct upstream concurrency', async () => {
    let release: ((response: Response) => void) | undefined;
    const fetchImpl = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const poll = createCodeBridgeStatusPoller({ fetchImpl, maxConcurrent: 1 });
    const params = {
      baseURL: 'https://code.example.com/v1',
      token: 'administrator-token',
      workerId: 'personal-vm',
    };

    const first = poll(params);
    expect(poll(params)).toBe(first);
    await expect(poll({ ...params, workerId: 'second-vm' })).rejects.toEqual(
      expect.objectContaining<Partial<CodeBridgeStatusError>>({ reason: 'busy' }),
    );
    release?.(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          workerId: 'personal-vm',
          online: false,
          ready: false,
        }),
      ),
    );
    await expect(first).resolves.toEqual({ status: 'offline' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('bypasses cached status without falling back on failure or changing normal polling', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const offline = () =>
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          workerId: 'personal-vm',
          online: false,
          ready: false,
        }),
      );
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(async () => offline())
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async () => offline());
    const poll = createCodeBridgeStatusPoller({ fetchImpl, maxConcurrent: 1 });
    const params = {
      baseURL: 'https://code.example.com/v1',
      token: 'administrator-token',
      workerId: 'personal-vm',
    };
    await expect(poll(params)).resolves.toEqual({ status: 'offline' });
    await expect(poll({ ...params, bypassCache: true })).rejects.toEqual(
      expect.objectContaining({ reason: 'failed' }),
    );
    await expect(poll({ ...params, bypassCache: true })).resolves.toEqual({ status: 'offline' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await expect(poll(params)).resolves.toEqual({ status: 'offline' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test('never joins an older in-flight poll and shares its upstream concurrency limit', async () => {
    const responses: Array<(response: Response) => void> = [];
    const fetchImpl = jest.fn(() => new Promise<Response>((resolve) => responses.push(resolve)));
    const poll = createCodeBridgeStatusPoller({ fetchImpl, maxConcurrent: 2 });
    const params = {
      baseURL: 'https://code.example.com/v1',
      token: 'administrator-token',
      workerId: 'personal-vm',
    };
    const previous = poll(params);
    const current = poll({ ...params, bypassCache: true });
    expect(current).not.toBe(previous);
    expect(poll(params)).toBe(previous);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(poll({ ...params, bypassCache: true })).rejects.toEqual(
      expect.objectContaining({ reason: 'busy' }),
    );
    await expect(poll({ ...params, workerId: 'second-vm' })).rejects.toEqual(
      expect.objectContaining({ reason: 'busy' }),
    );
    responses[1](
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          workerId: 'personal-vm',
          online: true,
          ready: true,
          leaseExpiresInMs: 50_000,
          capabilities: { sandboxProfile: 'native-srt', runtimes: ['bash'] },
        }),
      ),
    );
    await expect(current).resolves.toEqual(expect.objectContaining({ status: 'ready' }));
    responses[0](
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          workerId: 'personal-vm',
          online: false,
          ready: false,
        }),
      ),
    );
    await expect(previous).resolves.toEqual({ status: 'offline' });
    const next = poll({ ...params, bypassCache: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    responses[2](
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          workerId: 'personal-vm',
          online: false,
          ready: false,
        }),
      ),
    );
    await next;
  });

  test('does not coalesce status requests across credential rotations', async () => {
    const fetchImpl = jest.fn().mockImplementation((_input, init) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            workerId: 'personal-vm',
            online: false,
            ready: false,
            authorization: (init?.headers as Record<string, string>).Authorization,
          }),
        ),
      ),
    );
    const poll = createCodeBridgeStatusPoller({ fetchImpl });
    const params = {
      baseURL: 'https://code.example.com/v1',
      workerId: 'personal-vm',
    };

    await Promise.all([
      poll({ ...params, token: 'old-administrator-token' }),
      poll({ ...params, token: 'new-administrator-token' }),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('subtracts polling time when caching within the remaining worker lease', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchImpl = jest.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            workerId: 'personal-vm',
            online: true,
            ready: true,
            leaseExpiresInMs: 5,
            capabilities: { sandboxProfile: 'native-srt', runtimes: ['bash'] },
          }),
        ),
      ),
    );
    const poll = createCodeBridgeStatusPoller({ fetchImpl, cacheTtlMs: 2_000 });
    const params = {
      baseURL: 'https://code.example.com/v1',
      token: 'administrator-token',
      workerId: 'personal-vm',
    };

    const first = poll(params);
    now += 4;
    await first;
    now += 2;
    await poll(params);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  });

  test('holds upstream capacity until a rejected response body is cancelled', async () => {
    let finishCancellation: (() => void) | undefined;
    const rejectedBody = new ReadableStream({
      cancel: () =>
        new Promise<void>((resolve) => {
          finishCancellation = resolve;
        }),
    });
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response(rejectedBody, { status: 503 }))
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            workerId: 'second-vm',
            online: false,
            ready: false,
          }),
        ),
      );
    const poll = createCodeBridgeStatusPoller({ fetchImpl, maxConcurrent: 1 });
    const params = {
      baseURL: 'https://code.example.com/v1',
      token: 'administrator-token',
      workerId: 'personal-vm',
    };

    const first = poll(params);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(poll({ ...params, workerId: 'second-vm' })).rejects.toEqual(
      expect.objectContaining<Partial<CodeBridgeStatusError>>({ reason: 'busy' }),
    );
    finishCancellation?.();
    await expect(first).rejects.toEqual(
      expect.objectContaining<Partial<CodeBridgeStatusError>>({ reason: 'rejected' }),
    );
    await expect(poll({ ...params, workerId: 'second-vm' })).resolves.toEqual({
      status: 'offline',
    });
  });
});

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CodeBridgeFetch } from './bridge';
import {
  ATTACHED_WORKSPACE_BASH_DESCRIPTION,
  ATTACHED_WORKSPACE_BASH_SCHEMA,
  buildAttachedWorkspaceBashSchema,
  createAttachedWorkspaceBashTool,
  createGitIdentityProgrammaticBashTool,
  resolveAttachedWorkspaceCommandTimeoutMax,
  resolveAttachedWorkspaceProgrammaticTimeout,
  resolveAttachedWorkspaceQueueWaitMs,
  resolveAttachedWorkspaceRequestTimeoutMs,
} from './command';
import { BACKGROUND_TOOL_INVOCATION_CONFIG_KEY } from '~/agents/invocation';

describe('attached workspace Bash contract', () => {
  test('distinguishes durable workspace files from per-call and operator-managed state', () => {
    expect(ATTACHED_WORKSPACE_BASH_DESCRIPTION).toContain(
      'Only registered-workspace files persist',
    );
    expect(ATTACHED_WORKSPACE_BASH_DESCRIPTION).toContain('Install project dependencies there');
    expect(ATTACHED_WORKSPACE_BASH_DESCRIPTION).toContain('$HOME');
    expect(ATTACHED_WORKSPACE_BASH_DESCRIPTION).toContain('/tmp, $TMPDIR');
    expect(ATTACHED_WORKSPACE_BASH_DESCRIPTION).toContain('global/system packages');
    expect(ATTACHED_WORKSPACE_BASH_DESCRIPTION).toContain('background processes do not survive');
  });

  test('keeps the command parameter persistence warning next to generated commands', () => {
    expect(ATTACHED_WORKSPACE_BASH_SCHEMA).toMatchObject({
      properties: {
        command: {
          description: expect.stringContaining(
            'Only files written inside the workspace persist between calls',
          ),
        },
      },
    });
  });
});

describe('programmatic Bash Git identity', () => {
  test('applies authorship before the SDK sends a programmatic script', async () => {
    let receivedCode = '';
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      receivedCode = JSON.parse(body).code;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'completed', stdout: 'done', stderr: '', files: [] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const bashTool = createGitIdentityProgrammaticBashTool(
      { baseUrl: `http://127.0.0.1:${port}/v1`, authHeaders: () => ({}) },
      { name: "Agent O'Brien", email: 'agent@example.com' },
    );
    try {
      const invocationConfig = {
        tags: [],
        toolCall: { toolDefs: [] },
      };
      await bashTool.func(
        { code: 'git commit -m feature', tool_manifest: [] },
        undefined,
        invocationConfig,
      );
      expect(receivedCode).toContain(`GIT_AUTHOR_NAME='Agent O'"'"'Brien'`);
      expect(receivedCode).toContain("GIT_COMMITTER_EMAIL='agent@example.com'");
      expect(receivedCode).toContain('git commit -m feature');
      expect(receivedCode).not.toContain('git config');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  test('pins the selected project and conversation instance on the real SDK no-tools route', async () => {
    const received: {
      url?: string;
      workspace?: string | string[];
      code: string;
      workspace_instance_id?: string;
    }[] = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      received.push({
        url: req.url,
        workspace: req.headers['x-librechat-code-workspace-id'],
        ...JSON.parse(body),
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'completed', stdout: 'done', stderr: '', files: [] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const workspaceInstanceId = 'a'.repeat(64);
    try {
      const bashTool = createGitIdentityProgrammaticBashTool(
        {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          workspaceId: 'project-a',
          workspaceInstanceId,
          authHeaders: () => ({}),
        },
        { name: 'Lia', email: 'lia@example.com' },
      );
      const invocationConfig = { tags: [], toolCall: { toolDefs: [] } };
      await bashTool.func(
        { code: 'printf done', tool_manifest: [], workspaceId: 'forged-project' },
        undefined,
        invocationConfig,
      );
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        url: '/v1/exec/programmatic',
        workspace: 'project-a',
        workspace_instance_id: workspaceInstanceId,
      });
      expect(received[0].code).toContain("GIT_AUTHOR_NAME='Lia'");
      expect(bashTool.description).toContain('selected persistent workspace');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  test('preserves the foreground timeout while bounding an explicit admin override', () => {
    expect(resolveAttachedWorkspaceProgrammaticTimeout(undefined, 90_000)).toBe(30_000);
    expect(
      resolveAttachedWorkspaceProgrammaticTimeout(
        { limits: { maxCommandTimeoutMs: 120_000 } },
        90_000,
      ),
    ).toBe(90_000);
    expect(
      resolveAttachedWorkspaceProgrammaticTimeout(
        { limits: { maxCommandTimeoutMs: 60_000 } },
        90_000,
      ),
    ).toBe(60_000);
  });
});

function commandResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      protocolVersion: 1,
      operation: 'execute_command',
      workspaceId: 'project-a',
      exitCode: 0,
      stdout: 'ready\n',
      stderr: '',
      truncated: false,
      timedOut: false,
      ...overrides,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('createAttachedWorkspaceBashTool', () => {
  test('honors a zero Code API rate-limit retry budget', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(
      async () => new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }),
    );
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      codeApiMaxRetryWaitMs: 0,
      fetchImpl,
    });

    await expect(bashTool.invoke({ command: 'pwd' })).rejects.toThrow(
      'The operation was not started',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('dispatches commands to the resolved conversation workspace instance', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const workspaceInstanceId = 'e'.repeat(64);
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1/',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      workspaceInstanceId,
      fetchImpl,
    });

    await bashTool.invoke({ command: 'pwd' });

    const [, options] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({
      workspaceId: 'project-a',
      workspaceInstanceId,
    });
  });

  test('dispatches only advertised named actions with the resolved definition fingerprint', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1/',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      environment: {
        fingerprint: 'a'.repeat(64),
        repo: 'example/app',
        ref: 'main',
        actions: ['typecheck'],
      },
      fetchImpl,
    });
    await bashTool.invoke({ environmentAction: 'typecheck' });
    const [, options] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({
      workspaceId: 'project-a',
      environmentAction: { name: 'typecheck', fingerprint: 'a'.repeat(64) },
      timeoutMs: 30000,
    });
    for (const input of [
      { environmentAction: 'missing' },
      { environmentAction: 'typecheck', command: 'rm x' },
      { environmentAction: 'typecheck', cwd: 'other' },
      {},
    ]) {
      await expect(bashTool.invoke(input)).rejects.toThrow();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  test('disconnects the actual HTTP request when an invoked command is cancelled', async () => {
    let markStarted!: () => void;
    let markDisconnected!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const disconnected = new Promise<void>((resolve) => {
      markDisconnected = resolve;
    });
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* Consume the complete request before cancellation. */
      }
      res.once('close', () => {
        if (!res.writableEnded) markDisconnected();
      });
      markStarted();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      authHeaders: () => ({}),
      workspaceId: 'project-a',
    });
    const controller = new AbortController();
    try {
      const invocation = bashTool.invoke({ command: 'sleep 30' }, { signal: controller.signal });
      const settled = invocation.then(
        () => ({ rejected: false }),
        () => ({ rejected: true }),
      );
      await started;
      controller.abort();
      expect((await settled).rejected).toBe(true);
      await disconnected;
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });

  test('executes in the selected workspace and relative working directory', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const authHeaders = jest.fn().mockResolvedValue({
      Authorization: 'Bearer jwt',
      'X-LibreChat-Code-Worker-ID': 'user-worker',
    });
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1/',
      authHeaders,
      workspaceId: 'project-a',
      fetchImpl,
    });

    await expect(
      bashTool.func({ command: 'pwd', cwd: 'packages/api' }, undefined, {}),
    ).resolves.toEqual(['stdout:\nready\n\n[exit code: 0]', {}]);

    expect(authHeaders).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://code.example.com/v1/workspace-tools/execute',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt',
          'X-LibreChat-Code-Worker-ID': 'user-worker',
        }),
      }),
    );
    const request = JSON.parse(String((fetchImpl as jest.Mock).mock.calls[0][1]?.body));
    expect(request).toEqual({
      protocolVersion: 1,
      operation: 'execute_command',
      workspaceId: 'project-a',
      command: 'pwd',
      cwd: 'packages/api',
      timeoutMs: 30_000,
      maxOutputBytes: 256 * 1024,
    });
  });

  test('forwards a bounded per-call execution timeout', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      maxTimeoutMs: 300_000,
      fetchImpl,
    });

    await bashTool.invoke({ command: 'npm test', timeoutMs: 300_000 });

    const request = JSON.parse(String((fetchImpl as jest.Mock).mock.calls[0][1]?.body));
    expect(request).toMatchObject({ command: 'npm test', timeoutMs: 300_000 });
  });

  test('preserves the historical 30-second ceiling unless an administrator raises it', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      fetchImpl,
    });

    await expect(
      bashTool.func({ command: 'npm test', timeoutMs: 30_001 }, undefined, {}),
    ).rejects.toThrow('deployment limit of 30000 milliseconds');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('resolves and advertises an administrator-configured timeout ceiling', () => {
    const maxTimeoutMs = resolveAttachedWorkspaceCommandTimeoutMax({
      limits: { maxCommandTimeoutMs: 120_000 },
    });
    const schema = buildAttachedWorkspaceBashSchema(maxTimeoutMs);

    expect(maxTimeoutMs).toBe(120_000);
    expect(schema).toMatchObject({
      properties: { timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 } },
    });
    expect(resolveAttachedWorkspaceCommandTimeoutMax()).toBe(30_000);
    expect(resolveAttachedWorkspaceCommandTimeoutMax(undefined, 90_000)).toBe(90_000);
    expect(
      resolveAttachedWorkspaceCommandTimeoutMax(
        { limits: { maxCommandTimeoutMs: 120_000 } },
        90_000,
      ),
    ).toBe(90_000);
    expect(
      resolveAttachedWorkspaceCommandTimeoutMax(
        { limits: { maxCommandTimeoutMs: 60_000 } },
        90_000,
      ),
    ).toBe(60_000);
  });

  test('uses the negotiated ceiling only for omitted detached background timeouts', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      maxTimeoutMs: 90_000,
      fetchImpl,
    });

    await bashTool.invoke(
      { command: 'npm test' },
      { configurable: { [BACKGROUND_TOOL_INVOCATION_CONFIG_KEY]: true } },
    );
    await bashTool.invoke({ command: 'npm test' });

    const backgroundRequest = JSON.parse(String((fetchImpl as jest.Mock).mock.calls[0][1]?.body));
    const foregroundRequest = JSON.parse(String((fetchImpl as jest.Mock).mock.calls[1][1]?.body));
    expect(backgroundRequest).toMatchObject({ timeoutMs: 90_000 });
    expect(foregroundRequest).toMatchObject({ timeoutMs: 30_000 });
  });

  test('resolves the administrator-configured retry horizon', () => {
    expect(resolveAttachedWorkspaceQueueWaitMs()).toBe(5 * 60_000);
    expect(resolveAttachedWorkspaceQueueWaitMs({ limits: { maxQueueWaitMs: 30_000 } })).toBe(
      30_000,
    );
    expect(resolveAttachedWorkspaceQueueWaitMs({ limits: { maxQueueWaitMs: 0 } })).toBe(0);
    expect(resolveAttachedWorkspaceQueueWaitMs({ limits: { maxQueueWaitMs: 10 * 60_000 } })).toBe(
      5 * 60_000,
    );
  });

  test('opts Bash into a verified HTTP limit without changing execution or disabling the initial attempt', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    expect(resolveAttachedWorkspaceRequestTimeoutMs()).toBeUndefined();
    expect(
      resolveAttachedWorkspaceRequestTimeoutMs({ limits: { maxRequestTimeoutMs: 125_000 } }),
    ).toBe(125_000);
    expect(
      resolveAttachedWorkspaceRequestTimeoutMs({ limits: { maxRequestTimeoutMs: 610_001 } }),
    ).toBeUndefined();
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      maxTimeoutMs: 90_000,
      maxQueueWaitMs: 0,
      maxRequestTimeoutMs: 125_000,
      fetchImpl,
    });

    await bashTool.func({ command: 'sleep 90', timeoutMs: 90_000 }, undefined, {});
    await bashTool.func({ command: 'pwd' }, undefined, {});

    const [, long] = (fetchImpl as jest.Mock).mock.calls[0];
    const [, short] = (fetchImpl as jest.Mock).mock.calls[1];
    expect(JSON.parse(long.body).timeoutMs).toBe(90_000);
    expect(JSON.parse(short.body).timeoutMs).toBe(30_000);
    expect(long.headers['X-LibreChat-Workspace-Queue-Wait-Ms']).toBe('25000');
    expect(short.headers['X-LibreChat-Workspace-Queue-Wait-Ms']).toBe('85000');
  });

  test('lowers the omitted timeout when the deployment ceiling is below 30 seconds', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      maxTimeoutMs: 5_000,
      fetchImpl,
    });

    await bashTool.invoke({ command: 'npm test' });

    const request = JSON.parse(String((fetchImpl as jest.Mock).mock.calls[0][1]?.body));
    expect(request).toMatchObject({ timeoutMs: 5_000 });
    expect(buildAttachedWorkspaceBashSchema(5_000)).toMatchObject({
      properties: {
        timeoutMs: expect.objectContaining({
          maximum: 5_000,
          description: expect.stringContaining('Defaults to 5000'),
        }),
      },
    });
  });

  test.each([0, 300_001, 1.5])('rejects an invalid execution timeout of %p', async (timeoutMs) => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      fetchImpl,
    });

    await expect(bashTool.invoke({ command: 'npm test', timeoutMs })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('validates and invokes commands through the LangChain tool runtime', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      fetchImpl,
    });

    await expect(bashTool.invoke({ command: 'pwd' })).resolves.toBeDefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      Object.getOwnPropertyDescriptor(ATTACHED_WORKSPACE_BASH_SCHEMA, '__absolute_uri__'),
    ).toBeUndefined();
  });

  test('aborts an in-flight command without poisoning subsequent workspace reuse', async () => {
    let requestCount = 0;
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const fetchImpl: CodeBridgeFetch = jest.fn(async (_url, init) => {
      requestCount += 1;
      if (requestCount > 1) {
        return commandResponse({ stdout: 'reused\n' });
      }
      markRequestStarted();
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      fetchImpl,
    });
    const controller = new AbortController();

    const cancelled = bashTool.invoke({ command: 'sleep 30' }, { signal: controller.signal });
    await requestStarted;
    controller.abort();

    await expect(cancelled).rejects.toThrow('Aborted');
    await expect(bashTool.invoke({ command: 'pwd' })).resolves.toBe(
      'stdout:\nreused\n\n[exit code: 0]',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('preserves legacy positional args without interpolating shell metacharacters', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      fetchImpl,
    });

    await bashTool.func({ command: 'printf "%s" "$1"', args: ["a'b; echo unsafe"] }, undefined, {});

    const request = JSON.parse(String((fetchImpl as jest.Mock).mock.calls[0][1]?.body));
    expect(request.command).toBe(`bash -c 'printf "%s" "$1"' -- 'a'"'"'b; echo unsafe'`);
  });

  test('injects the configured agent Git identity without writing machine Git configuration', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      gitIdentity: { name: "Agent O'Brien", email: 'agent@example.com' },
      fetchImpl,
    });

    await bashTool.func({ command: 'git commit -m "Implement feature"' }, undefined, {});

    const request = JSON.parse(String((fetchImpl as jest.Mock).mock.calls[0][1]?.body));
    expect(request.command).toBe(
      `export GIT_AUTHOR_NAME='Agent O'"'"'Brien' GIT_AUTHOR_EMAIL='agent@example.com' GIT_COMMITTER_NAME='Agent O'"'"'Brien' GIT_COMMITTER_EMAIL='agent@example.com'; git commit -m "Implement feature"`,
    );
    expect(request.command).not.toContain('git config');
  });

  test('reports termination, timeouts, and truncation without hiding stderr', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () =>
      commandResponse({
        exitCode: null,
        signal: 'SIGKILL',
        stdout: '',
        stderr: 'deadline reached',
        truncated: true,
        timedOut: true,
      }),
    );
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      fetchImpl,
    });

    await expect(bashTool.func({ command: 'sleep 60' }, undefined, {})).resolves.toEqual([
      'stderr:\ndeadline reached\n[terminated by SIGKILL][timed out][output truncated]',
      {},
    ]);
  });
});

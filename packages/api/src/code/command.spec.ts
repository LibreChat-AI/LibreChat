import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createBashProgrammaticToolCallingTool } from '@librechat/agents';
import type { createBashProgrammaticToolCallingSchema } from '@librechat/agents';
import type { AddressInfo } from 'node:net';
import type { WorkspaceExecuteCommandRequest } from './workspace';
import type { CodeExecutionContext } from '~/agents/execution';
import type { CodeBridgeFetch } from './bridge';
import {
  ATTACHED_WORKSPACE_BASH_DESCRIPTION,
  ATTACHED_WORKSPACE_BASH_SCHEMA,
  buildAttachedWorkspaceBashSchema,
  createAttachedWorkspaceBashTool,
  createContextProgrammaticBashTool,
  createGitIdentityProgrammaticBashTool,
  resolveAttachedWorkspaceCommandTimeoutMax,
  resolveAttachedWorkspaceCommandTimeoutDefault,
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
    expect(ATTACHED_WORKSPACE_BASH_DESCRIPTION).toContain('not the final directory');
    expect(ATTACHED_WORKSPACE_BASH_DESCRIPTION).toContain(
      'Scripts are not automatically rewritten',
    );
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

  test.each([false, true])(
    'preserves the complete attached SDK schema with configured defaults and identity=%s',
    (withIdentity) => {
      const context: CodeExecutionContext = {
        baseUrl: 'http://127.0.0.1:9999/v1',
        codeSessionKey: 'execute_code:stateful:attached',
        executionProfile: 'stateful',
        environmentType: 'attached',
        statefulSessions: true,
        codeWorkspace: {
          environmentId: 'machine',
          workspaceId: 'project-a',
          workspaceInstanceId: 'a'.repeat(64),
          operations: ['execute_command'],
          maxCommandTimeoutMs: 80_000,
        },
        codeEnvironmentConfigSchema: {
          limits: { defaultCommandTimeoutMs: 60_000, maxCommandTimeoutMs: 80_000 },
        },
      };
      const baseline = createBashProgrammaticToolCallingTool({
        baseUrl: context.baseUrl,
        authHeaders: () => ({}),
        executionProfile: context.executionProfile,
        workspaceId: context.codeWorkspace?.workspaceId,
        workspaceInstanceId: context.codeWorkspace?.workspaceInstanceId,
        runTimeoutMs: 80_000,
      });
      const originalSchema = structuredClone(baseline.schema) as ReturnType<
        typeof createBashProgrammaticToolCallingSchema
      >;
      const configured = createContextProgrammaticBashTool(
        () => ({}),
        context,
        withIdentity ? { name: 'Lia', email: 'lia@example.com' } : undefined,
      );
      const schema = configured.schema as ReturnType<
        typeof createBashProgrammaticToolCallingSchema
      >;
      expect(schema.properties.code).toEqual(originalSchema.properties.code);
      expect(schema.properties.code.description).toContain('ATTACHED WORKSPACE EXECUTION');
      expect(schema.properties.code.description).toContain('${LIBRECHAT_CODE_DATA_DIR:-/mnt/data}');
      expect(schema).toEqual({
        ...originalSchema,
        properties: {
          ...originalSchema.properties,
          timeout: {
            ...originalSchema.properties.timeout,
            default: 60_000,
            description: expect.stringContaining('when timeout is omitted'),
          },
        },
      });
      expect(configured.description).toBe(baseline.description);
      expect(configured.schema).not.toBe(baseline.schema);
      expect(baseline.schema).toEqual(originalSchema);
      expect(
        createContextProgrammaticBashTool(() => ({}), {
          ...context,
          codeEnvironmentConfigSchema: { limits: { maxCommandTimeoutMs: 80_000 } },
        }).schema,
      ).toEqual(originalSchema);
    },
  );

  test('uses the foreground default only when the real SDK programmatic call omits timeout', async () => {
    const received: { timeout: number; code: string }[] = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      received.push(JSON.parse(body));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'completed', stdout: 'done', stderr: '', files: [] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    try {
      const bashTool = createContextProgrammaticBashTool(
        () => ({}),
        {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          codeSessionKey: 'execute_code:stateful:attached',
          executionProfile: 'stateful',
          environmentType: 'attached',
          statefulSessions: true,
          codeWorkspace: {
            environmentId: 'machine',
            workspaceId: 'project-a',
            operations: ['execute_command'],
            maxCommandTimeoutMs: 80_000,
          },
          codeEnvironmentConfigSchema: {
            limits: { defaultCommandTimeoutMs: 60_000, maxCommandTimeoutMs: 80_000 },
          },
        },
        { name: 'Lia', email: 'lia@example.com' },
      );
      const invocationConfig = {
        tags: [],
        toolCall: { name: 'run_tools_with_bash', args: {}, toolDefs: [] },
      };
      for (const timeout of [undefined, 75_000, 10_000, 90_000]) {
        await bashTool.invoke(
          { code: 'printf done', tool_manifest: [], ...(timeout == null ? {} : { timeout }) },
          invocationConfig,
        );
      }
      expect(received.map(({ timeout }) => timeout)).toEqual([60_000, 75_000, 10_000, 80_000]);
      expect(received.every(({ code }) => code.includes("GIT_AUTHOR_NAME='Lia'"))).toBe(true);
      expect(bashTool.schema).toMatchObject({
        properties: {
          timeout: {
            default: 60_000,
            description: expect.stringContaining('Default: 60000 milliseconds'),
          },
        },
      });
      expect(bashTool.schema).toMatchObject({
        properties: {
          timeout: { description: expect.stringContaining('Configured cap: 80000 milliseconds') },
        },
      });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  test.each([
    [60_000, 80_000, 50_000, undefined, 50_000, 50_000],
    [60_000, 80_000, 80_000, 65_000, 45_000, 45_000],
    [120_000, 80_000, 80_000, undefined, 80_000, 75_000],
    [1, 80_000, 80_000, undefined, 1_000, 75_000],
    [undefined, 80_000, 80_000, undefined, 80_000, 75_000],
    [undefined, undefined, 90_000, undefined, 30_000, 30_000],
  ])(
    'keeps real SDK defaults and explicit calls within admin/worker/HTTP ceilings (%s, %s, %s, %s)',
    async (
      defaultCommandTimeoutMs,
      maxCommandTimeoutMs,
      upstreamMaxTimeoutMs,
      maxRequestTimeoutMs,
      expectedDefault,
      expectedExplicit,
    ) => {
      const received: { timeout: number }[] = [];
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        received.push(JSON.parse(body));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'completed', stdout: 'done', stderr: '', files: [] }));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      try {
        const bashTool = createContextProgrammaticBashTool(() => ({}), {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          codeSessionKey: 'execute_code:stateful:attached',
          executionProfile: 'stateful',
          environmentType: 'attached',
          statefulSessions: true,
          codeWorkspace: {
            environmentId: 'machine',
            workspaceId: 'project-a',
            operations: ['execute_command'],
            maxCommandTimeoutMs: upstreamMaxTimeoutMs,
          },
          codeEnvironmentConfigSchema: {
            limits: { defaultCommandTimeoutMs, maxCommandTimeoutMs, maxRequestTimeoutMs },
          },
        });
        const config = { tags: [], toolCall: { toolDefs: [] } };
        await bashTool.func({ code: 'printf done', tool_manifest: [] }, undefined, config);
        await bashTool.func(
          { code: 'printf done', tool_manifest: [], timeout: 75_000 },
          undefined,
          config,
        );
        expect(received.map(({ timeout }) => timeout)).toEqual([expectedDefault, expectedExplicit]);
        expect(bashTool.schema).toMatchObject({
          properties: { timeout: { default: expectedDefault } },
        });
      } finally {
        server.close();
        await once(server, 'close');
      }
    },
  );

  test('refuses a newly configured programmatic ceiling below the SDK floor instead of raising it', () => {
    expect(() =>
      createContextProgrammaticBashTool(() => ({}), {
        baseUrl: 'http://127.0.0.1:9999/v1',
        codeSessionKey: 'execute_code:stateful:attached',
        executionProfile: 'stateful',
        environmentType: 'attached',
        statefulSessions: true,
        codeEnvironmentConfigSchema: {
          limits: { defaultCommandTimeoutMs: 1, maxCommandTimeoutMs: 500 },
        },
      }),
    ).toThrow('requires a timeout ceiling of at least 1000 milliseconds');
  });

  test('resolves the programmatic ceiling independently of the foreground default', () => {
    expect(
      resolveAttachedWorkspaceProgrammaticTimeout(
        { limits: { defaultCommandTimeoutMs: 60_000, maxCommandTimeoutMs: 80_000 } },
        70_000,
      ),
    ).toBe(70_000);
    expect(
      resolveAttachedWorkspaceProgrammaticTimeout(
        { limits: { defaultCommandTimeoutMs: 60_000, maxCommandTimeoutMs: 80_000 } },
        50_000,
      ),
    ).toBe(50_000);
    expect(
      resolveAttachedWorkspaceProgrammaticTimeout({ limits: { defaultCommandTimeoutMs: 60_000 } }),
    ).toBe(30_000);
    expect(
      resolveAttachedWorkspaceProgrammaticTimeout(
        {
          limits: {
            defaultCommandTimeoutMs: 60_000,
            maxCommandTimeoutMs: 80_000,
            maxRequestTimeoutMs: 65_000,
          },
        },
        80_000,
      ),
    ).toBe(45_000);
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
  test.each([
    [60_000, 80_000, undefined, 60_000],
    [120_000, 80_000, undefined, 80_000],
    [60_000, 80_000, 65_000, 45_000],
    [60_000, 5_000, undefined, 5_000],
    [1, 80_000, undefined, 1],
  ])(
    'bounds foreground default %i by ceiling %i and HTTP budget %s',
    async (defaultTimeoutMs, maxTimeoutMs, maxRequestTimeoutMs, expected) => {
      const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
      const bashTool = createAttachedWorkspaceBashTool({
        baseUrl: 'https://code.example.com/v1',
        authHeaders: () => ({}),
        workspaceId: 'project-a',
        defaultTimeoutMs,
        maxTimeoutMs,
        maxRequestTimeoutMs,
        fetchImpl,
      });
      await bashTool.invoke({ command: 'npm test' });
      expect(JSON.parse(String((fetchImpl as jest.Mock).mock.calls[0][1]?.body))).toMatchObject({
        timeoutMs: expected,
      });
      expect(bashTool.schema).toMatchObject({
        properties: {
          timeoutMs: {
            description: expect.stringContaining(`Defaults to ${expected} for foreground calls`),
          },
        },
      });
    },
  );

  test('keeps explicit and background timeouts independent of the foreground default', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      defaultTimeoutMs: 60_000,
      maxTimeoutMs: 80_000,
      fetchImpl,
    });
    await bashTool.invoke({ command: 'npm test', timeoutMs: 10_000 });
    await bashTool.invoke(
      { command: 'npm test' },
      { configurable: { [BACKGROUND_TOOL_INVOCATION_CONFIG_KEY]: true } },
    );
    await bashTool.invoke(
      { command: 'npm test', timeoutMs: 20_000 },
      { configurable: { [BACKGROUND_TOOL_INVOCATION_CONFIG_KEY]: true } },
    );
    expect(
      (fetchImpl as jest.Mock).mock.calls.map(
        ([, init]) => JSON.parse(String(init?.body)).timeoutMs,
      ),
    ).toEqual([10_000, 80_000, 20_000]);
  });

  test.each([0, -1, 1.5, NaN, Infinity])(
    'falls back safely for invalid foreground default %s',
    (defaultTimeoutMs) => {
      expect(resolveAttachedWorkspaceCommandTimeoutDefault(defaultTimeoutMs, 80_000)).toBe(30_000);
    },
  );

  test('does not raise the command ceiling when only a foreground default is configured', () => {
    const maxTimeoutMs = resolveAttachedWorkspaceCommandTimeoutMax({
      limits: { defaultCommandTimeoutMs: 60_000 },
    });
    expect(maxTimeoutMs).toBe(30_000);
    expect(resolveAttachedWorkspaceCommandTimeoutDefault(60_000, maxTimeoutMs)).toBe(30_000);
    const upstreamMax = resolveAttachedWorkspaceCommandTimeoutMax(
      { limits: { defaultCommandTimeoutMs: 60_000 } },
      50_000,
    );
    expect(resolveAttachedWorkspaceCommandTimeoutDefault(60_000, upstreamMax)).toBe(50_000);
  });

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
    const content = await bashTool.invoke({ environmentAction: 'typecheck' });
    expect(content).toContain('[starting directory: "workspace/"]');
    expect(content).not.toContain('directory hint');
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
    ).resolves.toEqual([
      '[starting directory: "workspace/packages/api"]\nstdout:\nready\n\n[exit code: 0]',
      {},
    ]);

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

  test('runs a command whose working directory is a linked worktree in that lane', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      linkedWorktrees: true,
      fetchImpl,
    });

    expect(JSON.stringify(bashTool.schema)).toContain('.worktrees/<name>');
    const [content] = await bashTool.func(
      { command: 'npm test', cwd: '.worktrees/fix-a/api' },
      undefined,
      {},
    );
    expect(content).toContain('[starting directory: "workspace/.worktrees/fix-a/api"]');

    const request = JSON.parse(String((fetchImpl as jest.Mock).mock.calls[0][1]?.body));
    expect(request).toMatchObject({ command: 'npm test', cwd: 'api', worktree: 'fix-a' });
  });

  test('reports the workspace root even when a command produces no output', async () => {
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      fetchImpl: async () => commandResponse({ stdout: '' }),
    });

    await expect(bashTool.invoke({ command: 'true' })).resolves.toBe(
      '[starting directory: "workspace/"]\nCommand completed with no output.\n[exit code: 0]',
    );
  });

  test.each([
    'cd packages/api && npm test',
    '\n\tcd "packages/api" && printf "%s" "$OLDPWD"',
    'cd missing && npm test || printf fallback',
    'cd "$DIRECTORY" && npm test',
    'cd .. && pwd',
    'cd - && pwd',
    'cd',
  ])('preserves the script and root lane while suggesting cwd: %s', async (command) => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      linkedWorktrees: true,
      fetchImpl,
    });

    const content = await bashTool.invoke({ command });
    expect(content).toContain('[starting directory: "workspace/"]');
    expect(content).toContain('pass cwd instead of a leading cd');
    expect(content).toContain('does not select a linked-worktree lane');
    expect(content).toContain('This command was not rewritten; do not rerun it');
    const request = JSON.parse(String((fetchImpl as jest.Mock).mock.calls[0][1]?.body));
    expect(request.command).toBe(command);
    expect(request).not.toHaveProperty('cwd');
    expect(request).not.toHaveProperty('worktree');
  });

  test('keeps cd worktree scripts root-scoped and directory feedback stateless', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      linkedWorktrees: true,
      fetchImpl,
    });
    const command = 'cd .worktrees/fix-a && npm test';
    await bashTool.invoke({ command });
    const content = await bashTool.invoke({ command: 'pwd' });
    expect(content).toContain('[starting directory: "workspace/"]');
    expect(content).not.toContain('directory hint');
    const requests = (fetchImpl as jest.Mock).mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)),
    );
    expect(requests[0].command).toBe(command);
    for (const request of requests) {
      expect(request).not.toHaveProperty('cwd');
      expect(request).not.toHaveProperty('worktree');
    }
  });

  test('escapes directory labels and does not mistake command names for cd', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      fetchImpl,
    });
    const cwd = 'folder\t"name';
    const content = await bashTool.invoke({ command: 'cdrom --help', cwd });
    expect(content).toContain(`[starting directory: ${JSON.stringify(`workspace/${cwd}`)}]`);
    expect(content).not.toContain('directory hint');
    expect(JSON.parse(String((fetchImpl as jest.Mock).mock.calls[0][1]?.body)).cwd).toBe(cwd);
  });

  test('never suggests linked-worktree routing when it was not negotiated', async () => {
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      fetchImpl: async () => commandResponse(),
    });
    const content = await bashTool.invoke({ command: 'cd child && pwd', cwd: 'parent' });
    expect(content).toContain('[starting directory: "workspace/parent"]');
    expect(content).toContain('directory hint');
    expect(content).not.toContain('linked-worktree lane');
  });

  test('reports the starting directory without changing real Bash state or fallback behavior', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lc-command-directory-'));
    const root = join(directory, 'project');
    await mkdir(join(root, 'child'), { recursive: true });
    const fetchImpl: CodeBridgeFetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as WorkspaceExecuteCommandRequest;
      const stdout = execFileSync('bash', ['-c', request.command], {
        cwd: request.cwd ? join(root, request.cwd) : root,
        encoding: 'utf8',
      });
      return commandResponse({ stdout });
    };
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      fetchImpl,
    });
    try {
      const content = await bashTool.invoke({
        command: 'cd child && printf "%s/%s" "${OLDPWD##*/}" "${PWD##*/}"',
      });
      expect(content).toContain('[starting directory: "workspace/"]');
      expect(content).toContain('stdout:\nproject/child');
      expect(content).not.toContain(directory);
      const fallback = await bashTool.invoke({
        command: 'cd missing 2>/dev/null && printf unexpected || printf fallback',
      });
      expect(fallback).toContain('stdout:\nfallback');
      const next = await bashTool.invoke({ command: 'printf "%s" "${PWD##*/}"' });
      expect(next).toContain('stdout:\nproject');
      const scoped = await bashTool.invoke({ command: 'printf "%s" "${PWD##*/}"', cwd: 'child' });
      expect(scoped).toContain('[starting directory: "workspace/child"]');
      expect(scoped).toContain('stdout:\nchild');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  test('fits the command ceiling inside a configured total HTTP budget', () => {
    expect(
      resolveAttachedWorkspaceCommandTimeoutMax({
        limits: { maxCommandTimeoutMs: 80_000, maxRequestTimeoutMs: 90_000 },
      }),
    ).toBe(70_000);
    expect(
      resolveAttachedWorkspaceCommandTimeoutMax({
        limits: { maxCommandTimeoutMs: 60_000, maxRequestTimeoutMs: 90_000 },
      }),
    ).toBe(60_000);
    expect(
      resolveAttachedWorkspaceCommandTimeoutMax({
        limits: {
          maxCommandTimeoutMs: 80_000,
          maxRequestTimeoutMs: 90_000,
          minCommandAdmissionMs: 15_000,
        },
      }),
    ).toBe(65_000);
    expect(
      resolveAttachedWorkspaceCommandTimeoutMax({
        limits: {
          maxCommandTimeoutMs: 80_000,
          maxRequestTimeoutMs: 90_000,
          minCommandAdmissionMs: 1_000,
        },
      }),
    ).toBe(79_000);
    expect(
      resolveAttachedWorkspaceCommandTimeoutMax(
        { limits: { maxCommandTimeoutMs: 120_000, maxRequestTimeoutMs: 125_000 } },
        90_000,
      ),
    ).toBe(90_000);
    expect(
      resolveAttachedWorkspaceCommandTimeoutMax({ limits: { maxCommandTimeoutMs: 120_000 } }),
    ).toBe(120_000);
  });

  test('starts an omitted background timeout that the configured budget can carry', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const configSchema = { limits: { maxCommandTimeoutMs: 80_000, maxRequestTimeoutMs: 90_000 } };
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      maxTimeoutMs: resolveAttachedWorkspaceCommandTimeoutMax(configSchema),
      maxRequestTimeoutMs: resolveAttachedWorkspaceRequestTimeoutMs(configSchema),
      fetchImpl,
    });

    await bashTool.invoke(
      { command: 'npm test' },
      { configurable: { [BACKGROUND_TOOL_INVOCATION_CONFIG_KEY]: true } },
    );

    const [, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({ timeoutMs: 70_000 });
    expect(init?.headers['X-LibreChat-Workspace-Queue-Wait-Ms']).toBe('10000');
    jest.restoreAllMocks();
  });

  test('reserves the configured admission allowance for an omitted background timeout', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const configSchema = {
      limits: {
        maxCommandTimeoutMs: 80_000,
        maxRequestTimeoutMs: 90_000,
        minCommandAdmissionMs: 15_000,
      },
    };
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      maxTimeoutMs: resolveAttachedWorkspaceCommandTimeoutMax(configSchema),
      maxRequestTimeoutMs: resolveAttachedWorkspaceRequestTimeoutMs(configSchema),
      minCommandAdmissionMs: configSchema.limits.minCommandAdmissionMs,
      fetchImpl,
    });

    expect(bashTool.schema).toMatchObject({
      properties: { timeoutMs: expect.objectContaining({ maximum: 65_000 }) },
    });
    await bashTool.invoke(
      { command: 'npm test' },
      { configurable: { [BACKGROUND_TOOL_INVOCATION_CONFIG_KEY]: true } },
    );
    const [, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({ timeoutMs: 65_000 });
    expect(init?.headers['X-LibreChat-Workspace-Queue-Wait-Ms']).toBe('15000');
    await expect(
      bashTool.func({ command: 'npm test', timeoutMs: 80_000 }, undefined, {}),
    ).rejects.toThrow('deployment limit of 65000 milliseconds');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

  test('still dispatches at the smallest supported reserve after credential-signing time', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => {
        now.mockReturnValue(1_200);
        return {};
      },
      workspaceId: 'project-a',
      maxTimeoutMs: 80_000,
      maxRequestTimeoutMs: 90_000,
      minCommandAdmissionMs: 1_000,
      fetchImpl,
    });

    await bashTool.invoke(
      { command: 'npm test' },
      { configurable: { [BACKGROUND_TOOL_INVOCATION_CONFIG_KEY]: true } },
    );
    const [, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({ timeoutMs: 79_000 });
    expect(init?.headers['X-LibreChat-Workspace-Queue-Wait-Ms']).toBe('800');
    jest.restoreAllMocks();
  });

  test('advertises and enforces only the timeout that fits when given both limits directly', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () => commandResponse());
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      maxTimeoutMs: 80_000,
      maxRequestTimeoutMs: 90_000,
      fetchImpl,
    });

    expect(bashTool.schema).toMatchObject({
      properties: { timeoutMs: expect.objectContaining({ maximum: 70_000 }) },
    });
    await expect(
      bashTool.func({ command: 'npm test', timeoutMs: 80_000 }, undefined, {}),
    ).rejects.toThrow('deployment limit of 70000 milliseconds');
    expect(fetchImpl).not.toHaveBeenCalled();
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
      '[starting directory: "workspace/"]\nstdout:\nreused\n\n[exit code: 0]',
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

  test('reports the requested timeout and effective retry ceiling after HTTP-budget clamping', async () => {
    const fetchImpl: CodeBridgeFetch = jest.fn(async () =>
      commandResponse({ exitCode: null, timedOut: true, stdout: 'partial work', stderr: '' }),
    );
    const bashTool = createAttachedWorkspaceBashTool({
      baseUrl: 'https://code.example.com/v1',
      authHeaders: () => ({}),
      workspaceId: 'project-a',
      defaultTimeoutMs: 60_000,
      maxTimeoutMs: 80_000,
      maxRequestTimeoutMs: 90_000,
      fetchImpl,
    });
    const [content] = await bashTool.func(
      { command: 'npm test', timeoutMs: 10_000 },
      undefined,
      {},
    );
    expect(content).toContain('partial work');
    expect(content).toContain('[starting directory: "workspace/"]');
    expect(content).toContain('timeoutMs: 10000');
    expect(content).toContain('up to 70000 milliseconds');
    expect(content).not.toContain('up to 80000');
    expect(content).toContain('partial side effects');
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
      '[starting directory: "workspace/"]\nstderr:\ndeadline reached\n[terminated by SIGKILL][timed out][output truncated]\nCommand reached timeoutMs: 30000. Before retrying, check for partial side effects. Set timeoutMs explicitly up to 30000 milliseconds, or use run_in_background: true if available. Background execution uses the same timeout ceiling.',
      {},
    ]);
  });
});

import { ErrorTypes } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { CodeExecutionContext, CodeEnvironmentConfig } from '~/agents/execution';
import {
  CodeWorkspaceSelectionError,
  resolveCodeExecutionWorkspaceContext,
  supportsProgrammaticCodeExecution,
} from './capabilities';

const context: CodeExecutionContext = {
  baseUrl: 'https://bridge.example',
  codeSessionKey: 'session',
  executionProfile: 'stateful',
  statefulSessions: true,
  environmentId: 'personal',
  environmentType: 'attached',
  bridgeWorkerId: 'worker',
};
const environments: CodeEnvironmentConfig[] = [
  {
    id: 'personal',
    name: 'Personal',
    type: 'attached',
    owner: 'principal',
    baseURL: context.baseUrl,
    workerId: 'worker',
    controlPlaneId: 'control-plane',
  },
  {
    id: 'control-plane',
    name: 'Control plane',
    type: 'attached',
    owner: 'deployment',
    baseURL: context.baseUrl,
    pairing: { allowPrincipalWorkers: true, tokenEnv: 'TEST_CODE_CAPABILITY_TOKEN' },
  },
];

const deploymentConfig = {
  endpoints: { agents: { statefulCodeSessions: { environments: [environments[1]] } } },
} as AppConfig;
const getAppConfig = jest.fn(async () => deploymentConfig);

describe('supportsProgrammaticCodeExecution', () => {
  beforeEach(() => {
    getAppConfig.mockClear();
  });

  afterEach(() => {
    delete process.env.TEST_CODE_CAPABILITY_TOKEN;
    delete process.env.TEST_PRIVATE_CAPABILITY_SECRET;
  });

  it.each([false, true, undefined])('requires explicit support: %s', async (statefulWorkspace) => {
    process.env.TEST_CODE_CAPABILITY_TOKEN = `token-${statefulWorkspace}`;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          workerId: 'worker',
          online: true,
          ready: true,
          leaseExpiresInMs: 45_000,
          capabilities: { statefulWorkspace, sandboxProfile: 'native-srt', runtimes: ['bash'] },
        }),
      ),
    );
    expect(await supportsProgrammaticCodeExecution(context, environments, getAppConfig)).toBe(
      statefulWorkspace === true,
    );
    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://bridge.example/bridge/workers/worker/status',
      expect.objectContaining({ headers: { Authorization: `Bearer token-${statefulWorkspace}` } }),
    );
  });

  it.each([
    { runtimes: [], supported: false },
    { runtimes: ['py'], supported: false },
    { runtimes: undefined, supported: false },
    { runtimes: ['py', 'bash'], supported: true },
  ])('requires advertised Bash support: $runtimes', async ({ runtimes, supported }) => {
    process.env.TEST_CODE_CAPABILITY_TOKEN = `runtimes-${JSON.stringify(runtimes)}`;
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          workerId: 'worker',
          online: true,
          ready: true,
          leaseExpiresInMs: 45_000,
          capabilities: { statefulWorkspace: true, sandboxProfile: 'native-srt', runtimes },
        }),
      ),
    );
    expect(await supportsProgrammaticCodeExecution(context, environments, getAppConfig)).toBe(
      supported,
    );
  });

  it('refreshes worker capabilities after the cached status expires', async () => {
    process.env.TEST_CODE_CAPABILITY_TOKEN = 'capability-transition-token';
    const startedAt = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(startedAt);
    const status = (runtimes: string[]) =>
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          workerId: 'worker',
          online: true,
          ready: true,
          leaseExpiresInMs: 45_000,
          capabilities: { statefulWorkspace: true, sandboxProfile: 'native-srt', runtimes },
        }),
      );
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(status(['bash']))
      .mockResolvedValueOnce(status(['py']));
    expect(await supportsProgrammaticCodeExecution(context, environments, getAppConfig)).toBe(true);
    expect(await supportsProgrammaticCodeExecution(context, environments, getAppConfig)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    now.mockReturnValue(startedAt + 2_001);
    expect(await supportsProgrammaticCodeExecution(context, environments, getAppConfig)).toBe(
      false,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('disables PTC when discovery fails', async () => {
    process.env.TEST_CODE_CAPABILITY_TOKEN = 'failed-token';
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(await supportsProgrammaticCodeExecution(context, environments, getAppConfig)).toBe(
      false,
    );
  });

  it('does not poll managed environments or environments without status credentials', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected status request'));
    expect(
      await supportsProgrammaticCodeExecution({ ...context, environmentType: 'managed' }),
    ).toBe(true);
    expect(await supportsProgrammaticCodeExecution()).toBe(true);
    expect(await supportsProgrammaticCodeExecution(context, environments, getAppConfig)).toBe(
      false,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('suppresses generic programmatic Bash after an attached workspace is selected', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected status request'));

    expect(
      await supportsProgrammaticCodeExecution(
        {
          ...context,
          codeWorkspace: {
            environmentId: 'personal',
            workspaceId: 'project-a',
            operations: ['read_file', 'execute_command'],
          },
        },
        environments,
        getAppConfig,
      ),
    ).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      languages: ['bash'],
      operation: 'execute_command',
      workspaceId: 'project-a',
      supported: true,
    },
    {
      languages: undefined,
      operation: 'execute_command',
      workspaceId: 'project-a',
      supported: false,
    },
    {
      languages: ['python'],
      operation: 'execute_command',
      workspaceId: 'project-a',
      supported: false,
    },
    { languages: ['bash'], operation: 'read_file', workspaceId: 'project-a', supported: false },
    { languages: ['bash'], operation: 'execute_command', workspaceId: 'removed', supported: false },
  ])(
    'gates selected project PTC using the live capability: %j',
    async ({ languages, operation, workspaceId, supported }) => {
      process.env.TEST_CODE_CAPABILITY_TOKEN = JSON.stringify({
        languages,
        operation,
        workspaceId,
      });
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            workerId: 'worker',
            online: true,
            ready: true,
            leaseExpiresInMs: 45000,
            capabilities: {
              statefulWorkspace: false,
              sandboxProfile: 'anthropic-srt',
              runtimes: [],
              workspaceTools: {
                protocolVersion: 1,
                operations: ['execute_command', 'read_file'],
                programmaticLanguages: languages,
                workspaces: [{ id: 'project-a', operations: [operation] }],
              },
            },
          }),
        ),
      );
      expect(
        await supportsProgrammaticCodeExecution(
          {
            ...context,
            codeWorkspace: {
              environmentId: 'personal',
              workspaceId,
              operations: ['execute_command', 'read_file'],
            },
          },
          environments,
          getAppConfig,
        ),
      ).toBe(supported);
    },
  );

  it('does not send credentials to a different execution route', async () => {
    process.env.TEST_CODE_CAPABILITY_TOKEN = 'route-token';
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected status request'));
    expect(
      await supportsProgrammaticCodeExecution(
        { ...context, baseUrl: 'https://different.example' },
        environments,
        getAppConfig,
      ),
    ).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('rejects a deployment environment override that redirects a process secret', async () => {
    process.env.TEST_PRIVATE_CAPABILITY_SECRET = 'must-not-leave-the-process';
    const override: CodeEnvironmentConfig = {
      ...environments[1],
      baseURL: 'https://attacker.example',
      pairing: {
        workerId: 'worker',
        allowPrincipalWorkers: false,
        tokenEnv: 'TEST_PRIVATE_CAPABILITY_SECRET',
      },
    };
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected status request'));
    expect(
      await supportsProgrammaticCodeExecution(
        {
          ...context,
          environmentId: override.id,
          baseUrl: override.baseURL,
        },
        [override],
        getAppConfig,
      ),
    ).toBe(false);
    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses only deployment credentials even if the effective control plane names another secret', async () => {
    process.env.TEST_CODE_CAPABILITY_TOKEN = 'deployment-only-token';
    process.env.TEST_PRIVATE_CAPABILITY_SECRET = 'must-not-leave-the-process';
    const override: CodeEnvironmentConfig = {
      ...environments[1],
      baseURL: 'https://attacker.example',
      pairing: { allowPrincipalWorkers: true, tokenEnv: 'TEST_PRIVATE_CAPABILITY_SECRET' },
    };
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          workerId: 'worker',
          online: true,
          ready: true,
          leaseExpiresInMs: 45_000,
          capabilities: {
            statefulWorkspace: true,
            sandboxProfile: 'native-srt',
            runtimes: ['bash'],
          },
        }),
      ),
    );
    expect(
      await supportsProgrammaticCodeExecution(context, [environments[0], override], getAppConfig),
    ).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://bridge.example/bridge/workers/worker/status',
      expect.objectContaining({ headers: { Authorization: 'Bearer deployment-only-token' } }),
    );
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain('must-not-leave-the-process');
  });

  it('requires the control plane in effective config before reading deployment config', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected status request'));
    expect(await supportsProgrammaticCodeExecution(context, [environments[0]], getAppConfig)).toBe(
      false,
    );
    expect(getAppConfig).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed when deployment configuration cannot be loaded', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected status request'));
    expect(
      await supportsProgrammaticCodeExecution(context, environments, async () => {
        throw new Error('unavailable');
      }),
    ).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('resolveCodeExecutionWorkspaceContext', () => {
  beforeEach(() => {
    getAppConfig.mockClear();
    process.env.TEST_CODE_CAPABILITY_TOKEN = `workspace-${Math.random()}`;
  });

  afterEach(() => {
    delete process.env.TEST_CODE_CAPABILITY_TOKEN;
  });

  function workspaceStatus(
    workspaces: unknown[],
    statefulWorkspace: boolean = true,
    maxCommandTimeoutMs?: number,
  ): Response {
    return new Response(
      JSON.stringify({
        protocolVersion: 1,
        workerId: 'worker',
        online: true,
        ready: true,
        leaseExpiresInMs: 45_000,
        maxCommandTimeoutMs,
        capabilities: {
          statefulWorkspace,
          sandboxProfile: 'native-srt',
          runtimes: ['bash'],
          workspaceTools: {
            protocolVersion: 1,
            operations: ['read_file', 'list_files', 'execute_command'],
            workspaces,
          },
        },
      }),
    );
  }

  it('binds the exact advertised workspace and its operation ceiling', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      workspaceStatus(
        [
          { id: 'project-a', name: 'Project A' },
          { id: 'docs', operations: ['read_file', 'list_files'] },
        ],
        true,
        120_000,
      ),
    );

    await expect(
      resolveCodeExecutionWorkspaceContext({
        context,
        requestedSelections: [
          { environmentId: 'another-machine', workspaceId: 'other-project' },
          { environmentId: 'personal', workspaceId: 'docs' },
        ],
        environments,
        getAppConfig,
      }),
    ).resolves.toMatchObject({
      codeSessionKey: 'session',
      codeWorkspace: {
        environmentId: 'personal',
        workspaceId: 'docs',
        operations: ['read_file', 'list_files'],
        maxCommandTimeoutMs: 120_000,
      },
    });
  });

  it('carries validated project metadata from the selected workspace', async () => {
    const environment = {
      fingerprint: 'a'.repeat(64),
      repo: 'example/app',
      ref: 'dev',
      actions: ['typecheck'],
    };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      workspaceStatus([
        { id: 'docs', environment },
        { id: 'other', environment: { ...environment, actions: ['other'] } },
      ]),
    );
    const resolved = await resolveCodeExecutionWorkspaceContext({
      context,
      requestedSelections: [{ environmentId: 'personal', workspaceId: 'docs' }],
      environments,
      getAppConfig,
    });
    expect(resolved.codeWorkspace?.environment).toEqual(environment);
  });

  it('activates a server-derived instance only when the worker advertises worktree support', async () => {
    const workspaceInstanceId = 'c'.repeat(64);
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        workspaceStatus([
          { id: 'worktree', workspaceInstances: ['git_worktree'] },
          { id: 'legacy' },
        ]),
      );

    const supported = await resolveCodeExecutionWorkspaceContext({
      context: { ...context, conversationWorkspaceInstanceId: workspaceInstanceId },
      requestedSelections: [{ environmentId: 'personal', workspaceId: 'worktree' }],
      environments,
      getAppConfig,
    });
    const legacy = await resolveCodeExecutionWorkspaceContext({
      context: { ...context, conversationWorkspaceInstanceId: workspaceInstanceId },
      requestedSelections: [{ environmentId: 'personal', workspaceId: 'legacy' }],
      environments,
      getAppConfig,
    });

    expect(supported.codeWorkspace?.workspaceInstanceId).toBe(workspaceInstanceId);
    expect(legacy.codeWorkspace).not.toHaveProperty('workspaceInstanceId');
  });

  it('admits native workspace tools without enabling programmatic runtime execution', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(workspaceStatus([{ id: 'docs', operations: ['read_file'] }], false));
    const resolved = await resolveCodeExecutionWorkspaceContext({
      context,
      requestedSelections: [{ environmentId: 'personal', workspaceId: 'docs' }],
      environments,
      getAppConfig,
    });
    expect(resolved.codeWorkspace).toEqual({
      environmentId: 'personal',
      workspaceId: 'docs',
      operations: ['read_file'],
    });
    expect(await supportsProgrammaticCodeExecution(context, environments, getAppConfig)).toBe(
      false,
    );
    expect(await supportsProgrammaticCodeExecution(resolved, environments, getAppConfig)).toBe(
      false,
    );
  });

  it.each([false, true])(
    'fails closed without native workspace capabilities (ready: %s)',
    async (ready) => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            workerId: 'worker',
            online: true,
            ready,
            leaseExpiresInMs: 45_000,
            capabilities: { statefulWorkspace: false, sandboxProfile: 'native-srt', runtimes: [] },
          }),
        ),
      );
      await expect(
        resolveCodeExecutionWorkspaceContext({
          context,
          requestedSelections: [{ environmentId: 'personal', workspaceId: 'docs' }],
          environments,
          getAppConfig,
        }),
      ).rejects.toMatchObject({ reason: ready ? 'unsupported' : 'worker_unavailable' });
    },
  );

  it.each(['worker', 'replacement', undefined])(
    'pins deployment worker identity: %s',
    async (workerId) => {
      const fetch = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(workspaceStatus([{ id: 'project-a' }]));
      const deploymentEnvironment: CodeEnvironmentConfig = {
        id: 'fixed',
        name: 'Fixed VM',
        type: 'attached',
        owner: 'deployment',
        baseURL: context.baseUrl,
        pairing: { workerId, tokenEnv: 'TEST_CODE_CAPABILITY_TOKEN', allowPrincipalWorkers: false },
      };
      const pending = resolveCodeExecutionWorkspaceContext({
        context: { ...context, environmentId: 'fixed' },
        requestedSelections: [{ environmentId: 'fixed', workspaceId: 'project-a' }],
        environments: [
          {
            ...deploymentEnvironment,
            pairing: {
              workerId: 'worker',
              tokenEnv: 'TEST_CODE_CAPABILITY_TOKEN',
              allowPrincipalWorkers: false,
            },
          },
        ],
        getAppConfig: jest.fn(
          async () =>
            ({
              endpoints: {
                agents: { statefulCodeSessions: { environments: [deploymentEnvironment] } },
              },
            }) as AppConfig,
        ),
      });
      if (workerId === 'worker') {
        await expect(pending).resolves.toMatchObject({
          codeWorkspace: { workspaceId: 'project-a' },
        });
      } else {
        await expect(pending).rejects.toMatchObject({ reason: 'worker_unavailable' });
        expect(fetch).not.toHaveBeenCalled();
      }
    },
  );

  it('uses the persisted binding when the request omits one', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(workspaceStatus([{ id: 'project-a' }]));

    await expect(
      resolveCodeExecutionWorkspaceContext({
        context,
        persistedSelections: [{ environmentId: 'personal', workspaceId: 'project-a' }],
        environments,
        getAppConfig,
      }),
    ).resolves.toMatchObject({
      codeWorkspace: { environmentId: 'personal', workspaceId: 'project-a' },
    });
  });

  it('accepts an equivalent retry regardless of selection order', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(workspaceStatus([{ id: 'project-a' }]));
    const personal = { environmentId: 'personal', workspaceId: 'project-a' };
    const team = { environmentId: 'team', workspaceId: 'project-b' };

    await expect(
      resolveCodeExecutionWorkspaceContext({
        context,
        requestedSelections: [team, personal],
        persistedSelections: [personal, team],
        environments,
        getAppConfig,
      }),
    ).resolves.toMatchObject({ codeWorkspace: personal });
  });

  it('rejects a request that changes a persisted workspace before contacting Code API', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected status request'));

    await expect(
      resolveCodeExecutionWorkspaceContext({
        context,
        requestedSelections: [{ environmentId: 'personal', workspaceId: 'project-b' }],
        persistedSelections: [{ environmentId: 'personal', workspaceId: 'project-a' }],
        environments,
        getAppConfig,
      }),
    ).rejects.toMatchObject({ reason: 'locked' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails when the saved workspace disappears instead of selecting another', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(workspaceStatus([{ id: 'replacement' }]));

    await expect(
      resolveCodeExecutionWorkspaceContext({
        context,
        requestedSelections: [{ environmentId: 'personal', workspaceId: 'project-a' }],
        environments,
        getAppConfig,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CodeWorkspaceSelectionError>>({
        reason: 'missing',
        code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
        status: 409,
        statusCode: 409,
      }),
    );
  });

  it('requires a binding for the executing environment before contacting Code API', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected status request'));

    await expect(
      resolveCodeExecutionWorkspaceContext({
        context,
        requestedSelections: [{ environmentId: 'another-machine', workspaceId: 'project-a' }],
        environments,
        getAppConfig,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CodeWorkspaceSelectionError>>({
        reason: 'required',
      }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects malformed selections before contacting Code API', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected status request'));

    await expect(
      resolveCodeExecutionWorkspaceContext({
        context,
        requestedSelections: [
          {
            environmentId: 'personal',
            workspaceId: 'project-a',
            operations: ['execute_command'],
          },
        ],
        environments,
        getAppConfig,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CodeWorkspaceSelectionError>>({ reason: 'invalid' }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects duplicate environment bindings before contacting Code API', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected status request'));

    await expect(
      resolveCodeExecutionWorkspaceContext({
        context,
        requestedSelections: [
          { environmentId: 'personal', workspaceId: 'project-a' },
          { environmentId: 'personal', workspaceId: 'project-b' },
        ],
        environments,
        getAppConfig,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CodeWorkspaceSelectionError>>({ reason: 'invalid' }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns an explicit unavailable error when deployment configuration cannot be loaded', async () => {
    await expect(
      resolveCodeExecutionWorkspaceContext({
        context,
        requestedSelections: [{ environmentId: 'personal', workspaceId: 'project-a' }],
        environments,
        getAppConfig: async () => {
          throw new Error('configuration unavailable');
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CodeWorkspaceSelectionError>>({
        reason: 'worker_unavailable',
      }),
    );
  });
});

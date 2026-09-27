import { EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { CodeEnvironmentGenerationJob } from './http';
import { CodeEnvironmentLimitError, CodeEnvironmentValidationError } from './environments';
import { createCodeEnvironmentHttpHandlers } from './http';

function response() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

describe('code environment HTTP handlers', () => {
  test.each(['allowed', 'denied', 'unpaired', 'changed-worker'])(
    'resolves deployment worker status only through effective authorization: %s',
    async (policy) => {
      const deploymentEnvironment = {
        id: 'deployment-vm',
        name: 'Deployment VM',
        type: 'attached' as const,
        owner: 'deployment' as const,
        baseURL: 'https://code.example.com/v1',
        pairing: { workerId: 'configured-worker', tokenEnv: 'CODE_ADMIN_TOKEN' },
      };
      let effectiveWorkerId: string | undefined = 'configured-worker';
      if (policy === 'unpaired') effectiveWorkerId = undefined;
      if (policy === 'changed-worker') effectiveWorkerId = 'replacement';
      const effectiveEnvironment = {
        ...deploymentEnvironment,
        pairing: {
          ...deploymentEnvironment.pairing,
          workerId: effectiveWorkerId,
        },
      };
      const fetchImpl = jest.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            workerId: 'configured-worker',
            online: true,
            ready: true,
            leaseExpiresInMs: 50_000,
            capabilities: {
              statefulWorkspace: true,
              sandboxProfile: 'native-srt',
              runtimes: ['bash'],
            },
          }),
        ),
      );
      const effectiveEnvironments = policy === 'denied' ? [] : [effectiveEnvironment];
      const handlers = createCodeEnvironmentHttpHandlers({
        getAppConfig: jest.fn().mockImplementation(async ({ baseOnly }) => ({
          endpoints: {
            [EModelEndpoint.agents]: {
              statefulCodeSessions: {
                environments: baseOnly ? [deploymentEnvironment] : effectiveEnvironments,
              },
            },
          },
        })),
        registry: {
          register: jest.fn(),
          listAccessible: jest.fn(),
          remove: jest.fn(),
          listAccessibleConfigurations: jest.fn().mockResolvedValue([]),
        },
        readSecret: () => 'administrator-token',
        fetchImpl,
      });
      const res = response();
      await handlers.status(
        {
          user: { id: 'user-1', role: 'USER' },
          params: { environmentId: 'deployment-vm' },
        } as never,
        res as never,
      );
      expect(res.statusCode).toBe(policy === 'allowed' ? 200 : 404);
      if (policy !== 'allowed') {
        expect(fetchImpl).not.toHaveBeenCalled();
        return;
      }
      expect(res.body).toEqual(
        expect.objectContaining({ environmentId: 'deployment-vm', statefulWorkspace: true }),
      );
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://code.example.com/v1/bridge/workers/configured-worker/status',
        expect.any(Object),
      );
    },
  );

  test('reports status only for an accessible worker through its current control plane', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          workerId: 'personal-vm',
          online: true,
          ready: true,
          leaseExpiresInMs: 50_000,
          capabilities: {
            sandboxProfile: 'native-srt',
            runtimes: ['bash'],
            workspaceTools: {
              protocolVersion: 1,
              operations: ['read_file', 'execute_command'],
              workspaces: [
                {
                  id: 'project-a',
                  name: 'Project A',
                  operations: ['read_file', 'execute_command'],
                },
              ],
            },
          },
        }),
      ),
    );
    const controlPlane = {
      id: 'self-service',
      name: 'Self service',
      type: 'attached' as const,
      baseURL: 'https://code.example.com/v1',
      owner: 'deployment' as const,
      pairing: { allowPrincipalWorkers: true, tokenEnv: 'CODE_ADMIN_TOKEN' },
    };
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.agents]: { statefulCodeSessions: { environments: [controlPlane] } },
        },
      } as unknown as AppConfig),
      registry: {
        register: jest.fn(),
        listAccessible: jest.fn(),
        listAccessibleConfigurations: jest.fn().mockResolvedValue([
          {
            id: 'personal-vm',
            name: 'Personal VM',
            type: 'attached',
            baseURL: 'https://stale.example.com/v1',
            controlPlaneId: 'self-service',
            owner: 'principal',
            workerId: 'personal-vm',
          },
        ]),
        remove: jest.fn(),
      },
      readSecret: jest.fn(() => 'administrator-token'),
      fetchImpl,
    });
    const res = response();
    const coalescedRes = response();

    await Promise.all([
      handlers.status(
        {
          user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
          params: { environmentId: 'personal-vm' },
        } as never,
        res as never,
      ),
      handlers.status(
        {
          user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
          params: { environmentId: 'personal-vm' },
        } as never,
        coalescedRes as never,
      ),
    ]);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      environmentId: 'personal-vm',
      status: 'ready',
      leaseExpiresInMs: 50_000,
      sandboxProfile: 'native-srt',
      runtimes: ['bash'],
      operations: ['read_file', 'execute_command'],
      workspaces: [
        {
          id: 'project-a',
          name: 'Project A',
          operations: ['read_file', 'execute_command'],
        },
      ],
    });
    expect(coalescedRes.body).toEqual(res.body);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://code.example.com/v1/bridge/workers/personal-vm/status',
      expect.objectContaining({ headers: { Authorization: 'Bearer administrator-token' } }),
    );
  });

  test('does not query status for an inaccessible environment', async () => {
    const fetchImpl = jest.fn();
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: { [EModelEndpoint.agents]: { statefulCodeSessions: { environments: [] } } },
      } as unknown as AppConfig),
      registry: {
        register: jest.fn(),
        listAccessible: jest.fn(),
        listAccessibleConfigurations: jest.fn().mockResolvedValue([]),
        remove: jest.fn(),
      },
      fetchImpl,
    });
    const res = response();

    await handlers.status(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
        params: { environmentId: 'another-users-vm' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('does not advertise principal pairing when Code API principal auth is disabled', async () => {
    const listAccessible = jest.fn();
    const listAccessibleConfigurations = jest.fn();
    const listAccessibleDetails = jest.fn().mockResolvedValue({
      summaries: [],
      configurations: [],
    });
    const resolvedPrincipals = [
      { principalType: 'role', principalId: 'USER' },
      { principalType: 'user', principalId: '68b2f0c498f24c1e78fa0001' },
    ];
    const resolvePrincipals = jest.fn().mockResolvedValue(resolvedPrincipals);
    const getAppConfig = jest.fn().mockResolvedValue({
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            environments: [
              {
                id: 'principal-workers',
                name: 'Principal workers',
                type: 'attached',
                baseURL: 'https://code.example.com/v1',
                owner: 'deployment',
                pairing: { allowPrincipalWorkers: true },
              },
            ],
          },
        },
      },
    } as AppConfig);
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig,
      registry: {
        register: jest.fn(),
        listAccessible,
        listAccessibleConfigurations,
        listAccessibleDetails,
        resolvePrincipals,
        remove: jest.fn(),
      },
      principalAuthEnabled: () => false,
    });
    const res = response();

    await handlers.list(
      { user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' } } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ environments: [], controlPlanes: [] });
    expect(listAccessibleDetails).toHaveBeenCalledTimes(1);
    expect(resolvePrincipals).toHaveBeenCalledTimes(1);
    expect(listAccessibleDetails).toHaveBeenCalledWith(
      expect.objectContaining({ principals: resolvedPrincipals }),
    );
    expect(getAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedPrincipals,
        skipRuntimeAugmentation: true,
      }),
    );
    expect(listAccessible).not.toHaveBeenCalled();
    expect(listAccessibleConfigurations).not.toHaveBeenCalled();
  });

  test('lists only principal control planes present in the caller effective policy', async () => {
    const getAppConfig = jest.fn().mockResolvedValue({
      endpoints: { [EModelEndpoint.agents]: { statefulCodeSessions: { environments: [] } } },
    } as unknown as AppConfig);
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig,
      registry: {
        register: jest.fn(),
        listAccessible: jest.fn().mockResolvedValue([]),
        remove: jest.fn(),
      },
      principalAuthEnabled: () => true,
    });
    const res = response();

    await handlers.list(
      {
        user: {
          id: '68b2f0c498f24c1e78fa0001',
          role: 'USER',
          tenantId: 'tenant-1',
        },
      } as never,
      res as never,
    );

    expect(res.body).toEqual({ environments: [], controlPlanes: [] });
    expect(getAppConfig).toHaveBeenCalledWith({
      role: 'USER',
      userId: '68b2f0c498f24c1e78fa0001',
      idOnTheSource: undefined,
      tenantId: 'tenant-1',
      failClosed: true,
      skipRuntimeAugmentation: true,
    });
  });

  test('returns 400 when registration has no request body', async () => {
    const register = jest.fn();
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn(),
      registry: { register, listAccessible: jest.fn(), remove: jest.fn() },
    });
    const res = response();

    await handlers.register(
      { user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' }, body: null } as never,
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(register).not.toHaveBeenCalled();
  });

  test('updates settings only through the selected control plane config schema', async () => {
    const updateSettings = jest.fn().mockResolvedValue({
      resourceId: '68b2f0c498f24c1e78fa0111',
      id: 'personal-vm',
      name: 'Personal VM',
      type: 'attached',
      canDelete: true,
    });
    const configSchema = {
      permissions: {
        fileWrite: { allowed: ['allow', 'ask', 'deny'] as const, default: 'ask' as const },
      },
    };
    const resolvedPrincipals = [
      { principalType: 'role', principalId: 'USER' },
      { principalType: 'user', principalId: '68b2f0c498f24c1e78fa0001' },
    ];
    const resolvePrincipals = jest.fn().mockResolvedValue(resolvedPrincipals);
    const listAccessibleConfigurations = jest.fn().mockResolvedValue([
      {
        id: 'personal-vm',
        name: 'Personal VM',
        type: 'attached',
        baseURL: 'https://code.example.com/v1',
        controlPlaneId: 'self-service',
        owner: 'principal',
      },
    ]);
    const getAppConfig = jest.fn().mockResolvedValue({
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            environments: [
              {
                id: 'self-service',
                name: 'Self service',
                type: 'attached',
                baseURL: 'https://code.example.com/v1',
                owner: 'deployment',
                configSchema,
              },
            ],
          },
        },
      },
    } as unknown as AppConfig);
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig,
      registry: {
        register: jest.fn(),
        listAccessible: jest.fn(),
        listAccessibleConfigurations,
        resolvePrincipals,
        updateSettings,
        remove: jest.fn(),
      },
    });
    const res = response();

    await handlers.updateSettings(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
        params: { environmentId: 'personal-vm' },
        body: { settings: { permissions: { fileWrite: 'allow' } } },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(resolvePrincipals).toHaveBeenCalledTimes(1);
    expect(listAccessibleConfigurations).toHaveBeenCalledWith(
      expect.objectContaining({ principals: resolvedPrincipals }),
    );
    expect(getAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedPrincipals, skipRuntimeAugmentation: true }),
    );
    expect(updateSettings).toHaveBeenCalledWith({
      actor: expect.objectContaining({
        userId: '68b2f0c498f24c1e78fa0001',
        principals: resolvedPrincipals,
      }),
      environmentId: 'personal-vm',
      settings: { permissions: { fileWrite: 'allow' } },
    });
    expect(res.body).toEqual({
      environment: expect.objectContaining({
        id: 'personal-vm',
        configSchema,
        settings: { permissions: { fileWrite: 'allow' } },
      }),
    });
  });

  test.each([
    [undefined, undefined, 5],
    [{ maxPerUser: 100 }, { maxPerUser: 100 }, 100],
    [{ maxPerUser: 100 }, { maxPerUser: 20 }, 20],
    [{ maxPerUser: 10 }, { maxPerUser: 100 }, 10],
    [{ enabled: false }, { enabled: true }, 0],
    [{ maxPerUser: 10 }, { maxPerUser: 0 }, 0],
  ])(
    'pairs with deployment %j and effective policy %j (limit %i)',
    async (deployment, effective, limit) => {
      const register = jest.fn().mockResolvedValue({
        resourceId: '68b2f0c498f24c1e78fa0111',
        id: 'code-generated',
        name: 'Personal VM',
        type: 'attached',
      });
      const fetchImpl = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          protocolVersion: 1,
          workerId: 'code-generated',
          code: 'a'.repeat(32),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
      const appConfig = {
        endpoints: {
          [EModelEndpoint.agents]: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [
                {
                  id: 'shared-code-api',
                  name: 'Shared Code API',
                  type: 'attached',
                  baseURL: 'https://code.librechat.example/v1',
                  owner: 'deployment',
                  pairing: {
                    allowPrincipalWorkers: true,
                    tokenEnv: 'CODE_ADMIN_TOKEN',
                  },
                },
              ],
            },
          },
        },
      } as AppConfig;
      const handlers = createCodeEnvironmentHttpHandlers({
        getAppConfig: jest.fn(
          async (options) =>
            ({
              ...appConfig,
              endpoints: {
                ...appConfig.endpoints,
                agents: {
                  ...appConfig.endpoints?.agents,
                  statefulCodeSessions: {
                    ...appConfig.endpoints?.agents?.statefulCodeSessions,
                    principalWorkers: options?.baseOnly ? deployment : effective,
                  },
                },
              },
            }) as AppConfig,
        ),
        registry: {
          register,
          listAccessible: jest.fn().mockResolvedValue([{ id: 'existing-machine' }]),
          remove: jest.fn(),
        },
        createEnvironmentId: () => 'code-generated',
        readSecret: jest.fn(() => 'administrator-token'),
        resolveTenantId: jest.fn(() => 'tenant-1'),
        principalAuthEnabled: jest.fn(() => true),
        principalAuthReady: jest.fn(),
        fetchImpl,
      });
      const req = {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
        body: {
          name: 'Personal VM',
          controlPlaneId: 'shared-code-api',
          workerId: 'attacker-worker',
          baseURL: 'https://attacker.example',
        },
      };
      const res = response();

      await handlers.pair(req as never, res as never);

      if (limit === 0) {
        expect(res.statusCode).toBe(403);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(register).not.toHaveBeenCalled();
        const discovery = response();
        await handlers.list(req as never, discovery as never);
        expect(discovery.statusCode).toBe(200);
        expect(discovery.body).toEqual({
          environments: [{ id: 'existing-machine' }],
          controlPlanes: [],
        });
        return;
      }
      expect(res.statusCode).toBe(201);
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://code.librechat.example/v1/bridge/pairings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer administrator-token' }),
          body: JSON.stringify({
            workerId: 'code-generated',
            binding: {
              tenantId: 'tenant-1',
              principal: { type: 'user', id: '68b2f0c498f24c1e78fa0001' },
            },
          }),
        }),
      );
      expect(register).toHaveBeenCalledWith({
        actor: {
          userId: '68b2f0c498f24c1e78fa0001',
          role: 'USER',
          idOnTheSource: null,
        },
        maxOwned: limit,
        environment: {
          id: 'code-generated',
          name: 'Personal VM',
          type: 'attached' as const,
          baseURL: 'https://code.librechat.example/v1',
          workerId: 'code-generated',
          controlPlaneId: 'shared-code-api',
          revocationTokenEnv: 'CODE_ADMIN_TOKEN',
          workerPrincipal: { type: 'user', id: '68b2f0c498f24c1e78fa0001' },
        },
      });
      expect(res.body).toEqual({
        environment: expect.objectContaining({ id: 'code-generated' }),
        pairing: expect.objectContaining({
          workerId: 'code-generated',
          code: 'a'.repeat(32),
          endpoint: 'https://code.librechat.example/v1',
        }),
      });
    },
  );

  test('revokes an upstream pairing when the atomic owner quota is exhausted', async () => {
    const fetchImpl = jest.fn(
      async (input: string | URL | Request) =>
        ({
          ok: true,
          json: async () =>
            String(input).endsWith('/bridge/pairings')
              ? {
                  protocolVersion: 1,
                  workerId: 'code-generated',
                  code: 'a'.repeat(32),
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                }
              : { protocolVersion: 1, revoked: true },
        }) as Response,
    );
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.agents]: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [
                {
                  id: 'shared-code-api',
                  name: 'Shared Code API',
                  type: 'attached',
                  baseURL: 'https://code.librechat.example/v1',
                  owner: 'deployment',
                  pairing: {
                    allowPrincipalWorkers: true,
                    tokenEnv: 'CODE_ADMIN_TOKEN',
                  },
                },
              ],
            },
          },
        },
      } as AppConfig),
      registry: {
        register: jest.fn().mockRejectedValue(new CodeEnvironmentLimitError()),
        listAccessible: jest.fn(),
        remove: jest.fn(),
      },
      createEnvironmentId: () => 'code-generated',
      readSecret: () => 'administrator-token',
      principalAuthEnabled: () => true,
      principalAuthReady: jest.fn().mockResolvedValue(undefined),
      fetchImpl,
    });
    const res = response();

    await handlers.pair(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
        body: { name: 'Personal VM', controlPlaneId: 'shared-code-api' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Personal code environment limit reached' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://code.librechat.example/v1/bridge/workers/code-generated/revoke',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('returns 503 without issuing a pairing when the initial principal check is unavailable', async () => {
    const fetchImpl = jest.fn();
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.agents]: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [
                {
                  id: 'shared-code-api',
                  name: 'Shared Code API',
                  type: 'attached',
                  baseURL: 'https://code.librechat.example/v1',
                  owner: 'deployment',
                  pairing: { allowPrincipalWorkers: true, tokenEnv: 'CODE_ADMIN_TOKEN' },
                },
              ],
            },
          },
        },
      } as AppConfig),
      registry: { register: jest.fn(), listAccessible: jest.fn(), remove: jest.fn() },
      createEnvironmentId: () => 'code-generated',
      readSecret: () => 'administrator-token',
      principalAuthEnabled: () => true,
      principalAuthReady: jest.fn(),
      principalIsActive: jest.fn().mockRejectedValue(new Error('user store unavailable')),
      fetchImpl,
    });
    const res = response();

    await handlers.pair(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
        body: { name: 'Personal VM', controlPlaneId: 'shared-code-api' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'Account status could not be confirmed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('revokes through the registry fence when the principal becomes inactive after registration', async () => {
    const remove = jest.fn(
      async ({ beforeDelete }: { beforeDelete?: (target: never) => Promise<void> }) => {
        await beforeDelete?.({} as never);
        return { id: 'code-generated' } as never;
      },
    );
    const principalIsActive = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const fetchImpl = jest.fn(
      async (input: string | URL | Request) =>
        ({
          ok: true,
          json: async () =>
            String(input).endsWith('/bridge/pairings')
              ? {
                  protocolVersion: 1,
                  workerId: 'code-generated',
                  code: 'a'.repeat(32),
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                }
              : { protocolVersion: 1, revoked: true },
        }) as Response,
    );
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.agents]: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [
                {
                  id: 'shared-code-api',
                  name: 'Shared Code API',
                  type: 'attached',
                  baseURL: 'https://code.librechat.example/v1',
                  owner: 'deployment',
                  pairing: { allowPrincipalWorkers: true, tokenEnv: 'CODE_ADMIN_TOKEN' },
                },
              ],
            },
          },
        },
      } as AppConfig),
      registry: {
        register: jest.fn().mockResolvedValue({ id: 'code-generated' }),
        listAccessible: jest.fn(),
        remove,
      },
      createEnvironmentId: () => 'code-generated',
      readSecret: () => 'administrator-token',
      principalAuthEnabled: () => true,
      principalAuthReady: jest.fn(),
      principalIsActive,
      fetchImpl,
    });
    const res = response();

    await handlers.pair(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
        body: { name: 'Personal VM', controlPlaneId: 'shared-code-api' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(409);
    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: 'code-generated',
        beforeDelete: expect.any(Function),
      }),
    );
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://code.librechat.example/v1/bridge/workers/code-generated/revoke',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('persists cleanup intent before compensating a registered pairing after removal fails', async () => {
    const markRevocationPending = jest.fn().mockResolvedValue(undefined);
    const remove = jest.fn().mockRejectedValue(new Error('registry removal failed'));
    const principalIsActive = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const fetchImpl = jest.fn(
      async (input: string | URL | Request) =>
        ({
          ok: true,
          json: async () =>
            String(input).endsWith('/bridge/pairings')
              ? {
                  protocolVersion: 1,
                  workerId: 'code-generated',
                  code: 'a'.repeat(32),
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                }
              : { protocolVersion: 1, revoked: true },
        }) as Response,
    );
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.agents]: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [
                {
                  id: 'shared-code-api',
                  name: 'Shared Code API',
                  type: 'attached',
                  baseURL: 'https://code.librechat.example/v1',
                  owner: 'deployment',
                  pairing: { allowPrincipalWorkers: true, tokenEnv: 'CODE_ADMIN_TOKEN' },
                },
              ],
            },
          },
        },
      } as AppConfig),
      registry: {
        register: jest.fn().mockResolvedValue({ id: 'code-generated' }),
        listAccessible: jest.fn(),
        remove,
        markRevocationPending,
      },
      createEnvironmentId: () => 'code-generated',
      readSecret: () => 'administrator-token',
      principalAuthEnabled: () => true,
      principalAuthReady: jest.fn(),
      principalIsActive,
      fetchImpl,
    });
    const res = response();

    await handlers.pair(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
        body: { name: 'Personal VM', controlPlaneId: 'shared-code-api' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(500);
    expect(markRevocationPending).toHaveBeenCalledWith('code-generated');
    expect(markRevocationPending.mock.invocationCallOrder[0]).toBeLessThan(
      fetchImpl.mock.invocationCallOrder[fetchImpl.mock.invocationCallOrder.length - 1] ?? 0,
    );
  });

  test('revokes an issued pairing when the post-issue principal check is unavailable', async () => {
    const register = jest.fn();
    const principalIsActive = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('user store unavailable'));
    const fetchImpl = jest.fn(
      async (input: string | URL | Request) =>
        ({
          ok: true,
          json: async () =>
            String(input).endsWith('/bridge/pairings')
              ? {
                  protocolVersion: 1,
                  workerId: 'code-generated',
                  code: 'a'.repeat(32),
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                }
              : { protocolVersion: 1, revoked: true },
        }) as Response,
    );
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.agents]: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [
                {
                  id: 'shared-code-api',
                  name: 'Shared Code API',
                  type: 'attached',
                  baseURL: 'https://code.librechat.example/v1',
                  owner: 'deployment',
                  pairing: { allowPrincipalWorkers: true, tokenEnv: 'CODE_ADMIN_TOKEN' },
                },
              ],
            },
          },
        },
      } as AppConfig),
      registry: { register, listAccessible: jest.fn(), remove: jest.fn() },
      createEnvironmentId: () => 'code-generated',
      readSecret: () => 'administrator-token',
      principalAuthEnabled: () => true,
      principalAuthReady: jest.fn(),
      principalIsActive,
      fetchImpl,
    });
    const res = response();

    await handlers.pair(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
        body: { name: 'Personal VM', controlPlaneId: 'shared-code-api' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(503);
    expect(register).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://code.librechat.example/v1/bridge/workers/code-generated/revoke',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('rejects self-service pairing without principal-aware Code API auth', async () => {
    const fetchImpl = jest.fn();
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn(),
      registry: { register: jest.fn(), listAccessible: jest.fn(), remove: jest.fn() },
      principalAuthEnabled: jest.fn(() => false),
      fetchImpl,
    });
    const res = response();

    await handlers.pair(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
        body: { name: 'Personal VM', controlPlaneId: 'self-service' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(409);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('does not pair through a control plane removed from the caller effective config', async () => {
    const fetchImpl = jest.fn();
    const baseConfig = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            environments: [
              {
                id: 'self-service',
                name: 'Self-service',
                type: 'attached',
                baseURL: 'https://code.librechat.example',
                owner: 'deployment',
                pairing: { allowPrincipalWorkers: true, tokenEnv: 'CODE_ADMIN_TOKEN' },
              },
            ],
          },
        },
      },
    } as AppConfig;
    const effectiveConfig = {
      endpoints: { [EModelEndpoint.agents]: { statefulCodeSessions: { environments: [] } } },
    } as unknown as AppConfig;
    const getAppConfig = jest.fn(async (options) =>
      options.baseOnly === true ? baseConfig : effectiveConfig,
    );
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig,
      registry: { register: jest.fn(), listAccessible: jest.fn(), remove: jest.fn() },
      readSecret: jest.fn(() => 'administrator-token'),
      principalAuthEnabled: jest.fn(() => true),
      principalAuthReady: jest.fn(),
      fetchImpl,
    });
    const res = response();

    await handlers.pair(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER', tenantId: 'tenant-1' },
        body: { name: 'Personal VM', controlPlaneId: 'self-service' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(404);
    expect(getAppConfig).toHaveBeenCalledWith({
      role: 'USER',
      userId: '68b2f0c498f24c1e78fa0001',
      idOnTheSource: undefined,
      tenantId: 'tenant-1',
      failClosed: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('fails closed when effective pairing policy cannot be loaded', async () => {
    const fetchImpl = jest.fn();
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn(async (options) => {
        if (options.baseOnly === true) return {} as AppConfig;
        throw new Error('authorization unavailable');
      }),
      registry: { register: jest.fn(), listAccessible: jest.fn(), remove: jest.fn() },
      principalAuthEnabled: jest.fn(() => true),
      principalAuthReady: jest.fn(),
      fetchImpl,
    });
    const res = response();

    await handlers.pair(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
        body: { name: 'Personal VM', controlPlaneId: 'self-service' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('authorizes pairing effectively but resolves destinations and secrets from deployment config', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        protocolVersion: 1,
        workerId: 'code-generated',
        code: 'a'.repeat(32),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    const deploymentConfig = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            environments: [
              {
                id: 'self-service',
                name: 'Self-service',
                type: 'attached',
                baseURL: 'https://code.librechat.example',
                owner: 'deployment',
                pairing: { allowPrincipalWorkers: true, tokenEnv: 'CODE_ADMIN_TOKEN' },
              },
            ],
          },
        },
      },
    } as AppConfig;
    const effectiveConfig = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            environments: [
              {
                id: 'self-service',
                name: 'Override attempt',
                type: 'attached',
                baseURL: 'https://attacker.example',
                owner: 'deployment',
                pairing: { allowPrincipalWorkers: true, tokenEnv: 'DATABASE_URL' },
              },
            ],
          },
        },
      },
    } as AppConfig;
    const readSecret = jest.fn((name) =>
      name === 'CODE_ADMIN_TOKEN' ? 'administrator-token' : 'database-secret',
    );
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn(async (options) =>
        options.baseOnly === true ? deploymentConfig : effectiveConfig,
      ),
      registry: {
        register: jest.fn().mockResolvedValue({ id: 'code-generated' }),
        listAccessible: jest.fn(),
        remove: jest.fn(),
      },
      createEnvironmentId: () => 'code-generated',
      readSecret,
      resolveTenantId: jest.fn(() => 'tenant-1'),
      principalAuthEnabled: jest.fn(() => true),
      principalAuthReady: jest.fn(),
      fetchImpl,
    });
    const res = response();

    await handlers.pair(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
        body: { name: 'Personal VM', controlPlaneId: 'self-service' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(201);
    expect(readSecret).toHaveBeenCalledWith('CODE_ADMIN_TOKEN');
    expect(readSecret).not.toHaveBeenCalledWith('DATABASE_URL');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://code.librechat.example/bridge/pairings',
      expect.any(Object),
    );
  });

  test('validates JWT signing before creating upstream pairing state', async () => {
    const fetchImpl = jest.fn();
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn(),
      registry: { register: jest.fn(), listAccessible: jest.fn(), remove: jest.fn() },
      principalAuthEnabled: jest.fn(() => true),
      principalAuthReady: jest.fn(() => {
        throw new Error('invalid signing key');
      }),
      fetchImpl,
    });
    const res = response();

    await handlers.pair(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
        body: { name: 'Personal VM', controlPlaneId: 'self-service' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('registers against an operator-configured control plane and ignores client URLs', async () => {
    const register = jest.fn().mockResolvedValue({
      resourceId: '68b2f0c498f24c1e78fa0111',
      id: 'personal-vm',
      name: 'Personal VM',
      type: 'attached',
    });
    const appConfig = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            allowedEnvironments: ['user'],
            environments: [
              {
                id: 'shared-code-api',
                name: 'Shared Code API',
                type: 'attached',
                baseURL: 'https://code.librechat.example',
                owner: 'deployment',
                pairing: { workerId: 'deployment-worker', tokenEnv: 'CODE_ADMIN_TOKEN' },
              },
            ],
          },
        },
      },
    } as AppConfig;
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn().mockResolvedValue(appConfig),
      registry: { register, listAccessible: jest.fn(), remove: jest.fn() },
      createEnvironmentId: () => 'personal-vm',
    });
    const req = {
      user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
      body: {
        name: 'Personal VM',
        controlPlaneId: 'shared-code-api',
        workerId: 'attacker-worker',
        baseURL: 'https://attacker.example',
      },
    };
    const res = response();

    await handlers.register(req as never, res as never);

    expect(res.statusCode).toBe(201);
    expect(register).toHaveBeenCalledWith({
      actor: {
        userId: '68b2f0c498f24c1e78fa0001',
        role: 'USER',
        idOnTheSource: null,
      },
      environment: {
        id: 'personal-vm',
        name: 'Personal VM',
        type: 'attached',
        baseURL: 'https://code.librechat.example',
        controlPlaneId: 'shared-code-api',
        workerId: 'deployment-worker',
        workerPrincipal: { type: 'deployment', id: 'shared-code-api' },
      },
    });
  });

  test('removes a fixed environment when its principal becomes inactive after registration', async () => {
    const register = jest.fn().mockResolvedValue({
      resourceId: '68b2f0c498f24c1e78fa0111',
      id: 'personal-vm',
      name: 'Personal VM',
      type: 'attached',
    });
    const remove = jest.fn().mockResolvedValue({ id: 'personal-vm' });
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.agents]: {
            statefulCodeSessions: {
              environments: [
                {
                  id: 'shared-code-api',
                  name: 'Shared Code API',
                  type: 'attached',
                  baseURL: 'https://code.librechat.example',
                  owner: 'deployment',
                  pairing: { workerId: 'deployment-worker' },
                },
              ],
            },
          },
        },
      } as AppConfig),
      registry: { register, listAccessible: jest.fn(), remove },
      createEnvironmentId: () => 'personal-vm',
      principalIsActive: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
    });
    const res = response();

    await handlers.register(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
        body: { name: 'Personal VM', controlPlaneId: 'shared-code-api' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(409);
    expect(remove).toHaveBeenCalledWith({
      actor: {
        userId: '68b2f0c498f24c1e78fa0001',
        role: 'USER',
        idOnTheSource: null,
      },
      environmentId: 'personal-vm',
    });
  });

  test('returns 503 without fixed registration when the principal check is unavailable', async () => {
    const register = jest.fn();
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.agents]: {
            statefulCodeSessions: {
              environments: [
                {
                  id: 'shared-code-api',
                  name: 'Shared Code API',
                  type: 'attached',
                  baseURL: 'https://code.librechat.example',
                  owner: 'deployment',
                  pairing: { workerId: 'deployment-worker' },
                },
              ],
            },
          },
        },
      } as AppConfig),
      registry: { register, listAccessible: jest.fn(), remove: jest.fn() },
      principalIsActive: jest.fn().mockRejectedValue(new Error('user store unavailable')),
    });
    const res = response();

    await handlers.register(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
        body: { name: 'Personal VM', controlPlaneId: 'shared-code-api' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(503);
    expect(register).not.toHaveBeenCalled();
  });

  test('does not register a fixed environment on a self-service-only control plane', async () => {
    const register = jest.fn();
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.agents]: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [
                {
                  id: 'self-service',
                  name: 'Self-service',
                  type: 'attached',
                  baseURL: 'https://code.librechat.example',
                  owner: 'deployment',
                  pairing: {
                    allowPrincipalWorkers: true,
                    tokenEnv: 'CODE_ADMIN_TOKEN',
                  },
                },
              ],
            },
          },
        },
      } as AppConfig),
      registry: { register, listAccessible: jest.fn(), remove: jest.fn() },
    });
    const res = response();

    await handlers.register(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'ADMIN' },
        body: { name: 'Invalid fixed route', controlPlaneId: 'self-service' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(404);
    expect(register).not.toHaveBeenCalled();
  });

  test('validates a pairing name before creating upstream state', async () => {
    const fetchImpl = jest.fn();
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.agents]: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [
                {
                  id: 'self-service',
                  name: 'Self-service',
                  type: 'attached',
                  baseURL: 'https://code.librechat.example',
                  owner: 'deployment',
                  pairing: {
                    allowPrincipalWorkers: true,
                    tokenEnv: 'CODE_ADMIN_TOKEN',
                  },
                },
              ],
            },
          },
        },
      } as AppConfig),
      registry: { register: jest.fn(), listAccessible: jest.fn(), remove: jest.fn() },
      readSecret: jest.fn(() => 'administrator-token'),
      principalAuthEnabled: jest.fn(() => true),
      principalAuthReady: jest.fn(),
      fetchImpl,
    });
    const res = response();

    await handlers.pair(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
        body: { name: 'x'.repeat(101), controlPlaneId: 'self-service' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('revokes a user-bound worker before deleting its registry entry', async () => {
    const remove = jest.fn(async ({ beforeDelete }) => {
      await beforeDelete({
        resourceId: '68b2f0c498f24c1e78fa0111',
        id: 'code-generated',
        name: 'Personal VM',
        type: 'attached',
        baseURL: 'https://code.librechat.example/v1',
        workerId: 'code-generated',
        controlPlaneId: 'self-service',
        revocationTokenEnv: 'CODE_ADMIN_TOKEN',
        workerPrincipal: { type: 'user', id: '68b2f0c498f24c1e78fa0001' },
      });
      return {
        resourceId: '68b2f0c498f24c1e78fa0111',
        id: 'code-generated',
        name: 'Personal VM',
        type: 'attached' as const,
        canDelete: true,
      };
    });
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ protocolVersion: 1, revoked: true }),
    });
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.agents]: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              environments: [
                {
                  id: 'self-service',
                  name: 'Self-service',
                  type: 'attached',
                  baseURL: 'https://code.librechat.example/v1',
                  owner: 'deployment',
                  pairing: {
                    allowPrincipalWorkers: true,
                    tokenEnv: 'CODE_ADMIN_TOKEN',
                  },
                },
              ],
            },
          },
        },
      } as AppConfig),
      registry: { register: jest.fn(), listAccessible: jest.fn(), remove },
      readSecret: jest.fn(() => 'administrator-token'),
      fetchImpl,
    });
    const res = response();

    await handlers.remove(
      {
        user: { id: '68b2f0c498f24c1e78fa0001', role: 'USER' },
        params: { environmentId: 'code-generated' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://code.librechat.example/v1/bridge/workers/code-generated/revoke',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer administrator-token' },
      }),
    );
    expect(remove).toHaveBeenCalled();
  });

  test.each([
    {
      error: new Error('mongo connection details'),
      status: 500,
      body: { error: 'Code environment registration failed' },
    },
    {
      error: new CodeEnvironmentValidationError('Code environment id is invalid'),
      status: 400,
      body: { error: 'Code environment id is invalid' },
    },
  ])('classifies registration failure with status $status', async ({ error, status, body }) => {
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.agents]: {
            statefulCodeSessions: {
              environments: [
                {
                  id: 'shared-code-api',
                  name: 'Shared Code API',
                  type: 'attached',
                  baseURL: 'https://code.librechat.example',
                  owner: 'deployment',
                  pairing: { workerId: 'deployment-worker' },
                },
              ],
            },
          },
        },
      } as AppConfig),
      registry: {
        register: jest.fn().mockRejectedValue(error),
        listAccessible: jest.fn(),
        remove: jest.fn(),
      },
    });
    const res = response();

    await handlers.register(
      {
        user: { id: '68b2f0c498f24c1e78fa0001' },
        body: { name: 'Personal VM', controlPlaneId: 'shared-code-api' },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual(body);
  });
});

describe('moving a sealed conversation code-environment decision', () => {
  type Selection = { environmentId: string; workspaceId: string };
  type StoredDecision = {
    conversationId: string;
    codeEnvironmentRevision?: number;
    codeEnvironmentMode?: 'attached' | 'without_attached';
    codeWorkspaces?: Selection[];
  };

  const userId = '68b2f0c498f24c1e78fa0001';
  const mac: Selection = { environmentId: 'mac', workspaceId: 'primary' };
  const vm: Selection = { environmentId: 'personal-vm', workspaceId: 'project-a' };
  const controlPlane = {
    id: 'self-service',
    name: 'Self service',
    type: 'attached' as const,
    baseURL: 'https://code.example.com/v1',
    owner: 'deployment' as const,
    pairing: { allowPrincipalWorkers: true, tokenEnv: 'CODE_ADMIN_TOKEN' },
  };

  function workerStatusResponse({
    ready = true,
    workspaces = [{ id: 'project-a', name: 'Project A' }],
  }: { ready?: boolean; workspaces?: Array<{ id: string; name?: string }> } = {}) {
    return new Response(
      JSON.stringify({
        protocolVersion: 1,
        workerId: 'personal-vm',
        online: true,
        ready,
        leaseExpiresInMs: 50_000,
        capabilities: {
          sandboxProfile: 'native-srt',
          runtimes: ['bash'],
          workspaceTools: { protocolVersion: 1, operations: ['read_file'], workspaces },
        },
      }),
    );
  }

  function setup({
    movesEnabled = true,
    allowAttachDetach = true,
    stored = {
      conversationId: 'conversation-1',
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [mac],
    },
    job,
    conversationRunIds = [],
    fetchImpl = jest.fn().mockImplementation(async () => workerStatusResponse()),
  }: {
    movesEnabled?: boolean;
    allowAttachDetach?: boolean;
    stored?: StoredDecision;
    job?: CodeEnvironmentGenerationJob;
    conversationRunIds?: string[];
    fetchImpl?: jest.Mock;
  } = {}) {
    const conversations = new Map<string, StoredDecision>([[stored.conversationId, stored]]);
    const listConversationRuns = jest.fn(async () => conversationRunIds);
    const getConversation = jest.fn(async (user: string, conversationId: string) =>
      user === userId ? (conversations.get(conversationId) ?? null) : null,
    );
    /** Mirrors the data-schemas compare-and-swap: the write lands only on the decision it read. */
    const replaceDecision = jest.fn(
      async ({
        conversationId,
        expected,
        codeEnvironmentMode,
        codeWorkspaces,
      }: {
        conversationId: string;
        expected: Pick<StoredDecision, 'codeEnvironmentMode' | 'codeWorkspaces'> & {
          codeEnvironmentRevision?: number;
        };
        codeEnvironmentMode: StoredDecision['codeEnvironmentMode'];
        codeWorkspaces?: Selection[];
      }) => {
        const current = conversations.get(conversationId);
        const decisionOf = (decision: Partial<StoredDecision> | undefined) =>
          JSON.stringify([
            decision?.codeEnvironmentMode ?? null,
            decision?.codeWorkspaces ?? null,
            (decision as { codeEnvironmentRevision?: number })?.codeEnvironmentRevision ?? null,
          ]);
        if (current == null || decisionOf(current) !== decisionOf(expected)) {
          return null;
        }
        /** Mirrors the stored shape: leaving attached execution clears the selections. */
        const moved: StoredDecision =
          codeEnvironmentMode === 'attached'
            ? { ...current, codeEnvironmentMode, codeWorkspaces }
            : { conversationId: current.conversationId, codeEnvironmentMode };
        conversations.set(conversationId, moved);
        return moved;
      },
    );
    const handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.agents]: {
            statefulCodeSessions: {
              environments: [controlPlane],
              conversationMoves: { enabled: movesEnabled, allowAttachDetach },
            },
          },
        },
      } as unknown as AppConfig),
      registry: {
        register: jest.fn(),
        listAccessible: jest.fn(),
        listAccessibleConfigurations: jest.fn().mockResolvedValue([
          {
            id: 'personal-vm',
            name: 'Personal VM',
            type: 'attached',
            baseURL: 'https://stale.example.com/v1',
            controlPlaneId: 'self-service',
            owner: 'principal',
            workerId: 'personal-vm',
          },
        ]),
        remove: jest.fn(),
      },
      readSecret: jest.fn(() => 'administrator-token'),
      fetchImpl,
      conversations: {
        get: getConversation,
        replaceDecision,
      },
      generations: {
        getJob: async () => job ?? null,
        getCleanupBlockingJobIdsForConversations: listConversationRuns,
      },
    });
    const move = async (
      body: { from?: unknown; to?: unknown },
      conversationId = 'conversation-1',
    ) => {
      const res = response();
      await handlers.moveConversationDecision(
        { user: { id: userId, role: 'USER' }, params: { conversationId }, body } as never,
        res as never,
      );
      return res;
    };
    const status = async () => {
      const res = response();
      await handlers.status(
        {
          user: { id: userId, role: 'USER' },
          params: { environmentId: vm.environmentId },
        } as never,
        res as never,
      );
      return res;
    };
    return {
      move,
      status,
      conversations,
      getConversation,
      listConversationRuns,
      replaceDecision,
      fetchImpl,
    };
  }

  test('moves a sealed decision onto a workspace the new machine registers', async () => {
    const { move, conversations, fetchImpl } = setup();

    const res = await move({ from: [mac], to: [vm] });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      conversationId: 'conversation-1',
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [vm],
    });
    expect(conversations.get('conversation-1')?.codeWorkspaces).toEqual([vm]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://code.example.com/v1/bridge/workers/personal-vm/status',
      expect.objectContaining({ headers: { Authorization: 'Bearer administrator-token' } }),
    );
  });

  test.each(['attached', undefined] as const)(
    'recovers a missing workspace on the same machine with mode %s and keeps the new decision sealed',
    async (codeEnvironmentMode) => {
      const missing = { ...vm, workspaceId: 'deleted-project' };
      const { move, conversations, fetchImpl } = setup({
        stored: {
          conversationId: 'conversation-1',
          codeEnvironmentMode,
          codeWorkspaces: [missing],
        },
      });

      const res = await move({ from: [missing], to: [vm] });

      expect(res.statusCode).toBe(200);
      expect(conversations.get('conversation-1')).toEqual({
        conversationId: 'conversation-1',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [vm],
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect((await move({ from: [missing], to: [vm] })).statusCode).toBe(409);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    {
      name: 'old workspace restored',
      workspaces: ['deleted-project', 'project-a'],
      ready: true,
      reason: 'locked',
    },
    { name: 'replacement removed', workspaces: ['unrelated'], ready: true, reason: 'missing' },
    {
      name: 'worker unavailable',
      workspaces: ['project-a'],
      ready: false,
      reason: 'worker_unavailable',
    },
    { name: 'workspace still missing', workspaces: ['project-a'], ready: true, reason: undefined },
  ])(
    'revalidates recovery after a cached status poll: $name',
    async ({ workspaces, ready, reason }) => {
      jest.spyOn(Date, 'now').mockReturnValue(1_000);
      const old = { ...vm, workspaceId: 'deleted-project' };
      const fetchImpl = jest
        .fn()
        .mockImplementationOnce(async () => workerStatusResponse())
        .mockImplementation(async () =>
          workerStatusResponse({ workspaces: workspaces.map((id) => ({ id })), ready }),
        );
      const { move, status, conversations, replaceDecision } = setup({
        stored: { conversationId: 'conversation-1', codeWorkspaces: [old] },
        fetchImpl,
      });
      expect((await status()).statusCode).toBe(200);
      expect((await status()).statusCode).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      const res = await move({ from: [old], to: [vm] });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(res.statusCode).toBe(reason == null ? 200 : 409);
      if (reason != null) {
        expect(res.body).toEqual(expect.objectContaining({ reason }));
        expect(replaceDecision).not.toHaveBeenCalled();
      }
      expect(conversations.get('conversation-1')?.codeWorkspaces).toEqual(
        reason == null ? [vm] : [old],
      );
    },
  );

  test('refuses replacement if the old workspace is still registered or was restored', async () => {
    const old = { ...vm, workspaceId: 'old-project' };
    const { move, conversations, replaceDecision, fetchImpl } = setup({
      stored: { conversationId: 'conversation-1', codeWorkspaces: [old] },
      fetchImpl: jest.fn(async () =>
        workerStatusResponse({ workspaces: [{ id: old.workspaceId }, { id: vm.workspaceId }] }),
      ),
    });

    const res = await move({ from: [old], to: [vm] });

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ reason: 'locked' }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(replaceDecision).not.toHaveBeenCalled();
    expect(conversations.get('conversation-1')?.codeWorkspaces).toEqual([old]);
  });

  test.each([
    { ready: false, workspaces: [{ id: vm.workspaceId }], reason: 'worker_unavailable' },
    { ready: true, workspaces: [{ id: 'unrelated' }], reason: 'missing' },
    { ready: true, workspaces: [], reason: 'worker_unavailable' },
  ])(
    'leaves a missing decision untouched when recovery fails: $reason',
    async ({ reason, ...status }) => {
      const old = { ...vm, workspaceId: 'deleted-project' };
      const { move, conversations, replaceDecision } = setup({
        stored: { conversationId: 'conversation-1', codeWorkspaces: [old] },
        fetchImpl: jest.fn(async () => workerStatusResponse(status)),
      });

      const res = await move({ from: [old], to: [vm] });

      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual(expect.objectContaining({ reason }));
      expect(replaceDecision).not.toHaveBeenCalled();
      expect(conversations.get('conversation-1')?.codeWorkspaces).toEqual([old]);
    },
  );

  test('moves a legacy decision that only stored its selections', async () => {
    const { move, conversations } = setup({
      stored: { conversationId: 'conversation-1', codeWorkspaces: [mac] },
    });

    const res = await move({ from: [mac], to: [vm] });

    expect(res.statusCode).toBe(200);
    expect(conversations.get('conversation-1')).toEqual({
      conversationId: 'conversation-1',
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [vm],
    });
  });

  test.each([
    { name: 'running', job: { status: 'running' as const } },
    { name: 'awaiting approval', job: { status: 'requires_action' as const } },
    {
      name: 'settled but still saving its response',
      job: { status: 'complete' as const, metadata: { terminalPersistencePending: true } },
    },
  ])(
    'refuses while a generation is $name, since it saves the decision it started with',
    async ({ job }) => {
      const { move, replaceDecision, fetchImpl } = setup({ job });

      const res = await move({ from: [mac], to: [vm] });

      expect(res.statusCode).toBe(409);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(replaceDecision).not.toHaveBeenCalled();
    },
  );

  test('refuses while a remote run keyed by its response id still works on the conversation', async () => {
    const { move, listConversationRuns, replaceDecision, fetchImpl } = setup({
      conversationRunIds: ['resp_remote-run'],
    });

    const res = await move({ from: [mac], to: [vm] });

    expect(res.statusCode).toBe(409);
    expect(listConversationRuns).toHaveBeenCalledWith(userId, ['conversation-1'], undefined);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(replaceDecision).not.toHaveBeenCalled();
  });

  test('drops an environment the agents stopped using after revalidating the one it keeps', async () => {
    const gone = { environmentId: 'gone-vm', workspaceId: 'root' };
    const { move, conversations, fetchImpl } = setup({
      stored: {
        conversationId: 'conversation-1',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [gone, vm],
      },
    });

    const res = await move({ from: [gone, vm], to: [vm] });

    expect(res.statusCode).toBe(200);
    expect(conversations.get('conversation-1')?.codeWorkspaces).toEqual([vm]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('rejects a move whose kept workspace is no longer registered', async () => {
    const gone = { environmentId: 'gone-vm', workspaceId: 'root' };
    const { move, conversations, replaceDecision } = setup({
      stored: {
        conversationId: 'conversation-1',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [gone, vm],
      },
      fetchImpl: jest
        .fn()
        .mockImplementation(async () =>
          workerStatusResponse({ workspaces: [{ id: 'another-project' }] }),
        ),
    });

    const res = await move({ from: [gone, vm], to: [vm] });

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ reason: 'missing' }));
    expect(replaceDecision).not.toHaveBeenCalled();
    expect(conversations.get('conversation-1')?.codeWorkspaces).toEqual([gone, vm]);
  });

  test('attaches a workspace to a chat that recorded running without one', async () => {
    const { move, conversations, fetchImpl } = setup({
      stored: { conversationId: 'conversation-1', codeEnvironmentMode: 'without_attached' },
    });

    const res = await move({ from: [], to: [vm] });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      conversationId: 'conversation-1',
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [vm],
    });
    expect(conversations.get('conversation-1')).toEqual({
      conversationId: 'conversation-1',
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [vm],
    });
    /** The attached workspace is revalidated exactly like a move's target. */
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('rejects attaching a workspace the machine does not register', async () => {
    const { move, conversations, replaceDecision } = setup({
      stored: { conversationId: 'conversation-1', codeEnvironmentMode: 'without_attached' },
      fetchImpl: jest
        .fn()
        .mockImplementation(async () =>
          workerStatusResponse({ workspaces: [{ id: 'another-project' }] }),
        ),
    });

    const res = await move({ from: [], to: [vm] });

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ reason: 'missing' }));
    expect(replaceDecision).not.toHaveBeenCalled();
    expect(conversations.get('conversation-1')).toEqual({
      conversationId: 'conversation-1',
      codeEnvironmentMode: 'without_attached',
    });
  });

  test('leaves an attached machine without polling it and clears the selections', async () => {
    const { move, conversations, fetchImpl } = setup();

    const res = await move({ from: [mac], to: [] });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      conversationId: 'conversation-1',
      codeEnvironmentMode: 'without_attached',
    });
    /** The machine a chat is leaving is usually the unreachable one; checking it would refuse the
     *  one transition that works while it is down. */
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(conversations.get('conversation-1')).toEqual({
      conversationId: 'conversation-1',
      codeEnvironmentMode: 'without_attached',
    });
  });

  test('refuses to leave while a generation is still running', async () => {
    const { move, replaceDecision } = setup({ job: { status: 'running' } });

    expect((await move({ from: [mac], to: [] })).statusCode).toBe(409);
    expect(replaceDecision).not.toHaveBeenCalled();
  });

  /* Revalidating the target is a round trip to the worker, so the earlier checks are stale when it
   * returns. A turn that starts in that window would run in the previous environment while the
   * conversation reports the new one, and the swap would still succeed: the stored decision it
   * expects is unchanged, because a run never rewrites one the conversation already holds. */
  test('refuses when a generation starts while the target worker is being checked', async () => {
    const job: CodeEnvironmentGenerationJob = {
      status: 'complete',
      metadata: { terminalPersistencePending: false },
    };
    const fetchImpl = jest.fn().mockImplementation(async () => {
      job.status = 'running';
      return workerStatusResponse();
    });
    const { move, conversations, replaceDecision } = setup({ job, fetchImpl });

    const res = await move({ from: [mac], to: [vm] });

    expect(res.statusCode).toBe(409);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(replaceDecision).not.toHaveBeenCalled();
    expect(conversations.get('conversation-1')?.codeWorkspaces).toEqual([mac]);
  });

  test('refuses when a remote run claims the conversation during that check', async () => {
    const runIds: string[] = [];
    const fetchImpl = jest.fn().mockImplementation(async () => {
      runIds.push('resp_remote-run');
      return workerStatusResponse();
    });
    const { move, replaceDecision } = setup({ conversationRunIds: runIds, fetchImpl });

    expect((await move({ from: [mac], to: [vm] })).statusCode).toBe(409);
    expect(replaceDecision).not.toHaveBeenCalled();
  });

  test('preserves moves but rejects attach and detach in a move-only deployment', async () => {
    const context = setup({ allowAttachDetach: false });
    expect((await context.move({ from: [mac], to: [] })).statusCode).toBe(403);
    expect(context.replaceDecision).not.toHaveBeenCalled();
    expect((await context.move({ from: [mac], to: [vm] })).statusCode).toBe(200);
    const unattached = setup({
      allowAttachDetach: false,
      stored: {
        conversationId: 'conversation-1',
        codeEnvironmentMode: 'without_attached',
      },
    });
    expect((await unattached.move({ from: [], to: [vm] })).statusCode).toBe(403);
    expect(unattached.fetchImpl).not.toHaveBeenCalled();
    expect(unattached.replaceDecision).not.toHaveBeenCalled();
  });

  test('rejects when an admitted read advances the revision after the final idle check', async () => {
    const context = setup();
    const swap = context.replaceDecision.getMockImplementation()!;
    context.replaceDecision.mockImplementationOnce(async (args) => {
      // The real readAdmittedConvoCodeEnvironmentDecision advances this in Mongo atomically.
      context.conversations.set('conversation-1', {
        ...context.conversations.get('conversation-1')!,
        codeEnvironmentRevision: 1,
      } as StoredDecision);
      return swap(args);
    });
    const res = await context.move({ from: [mac], to: [vm] });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ reason: 'locked' }));
    expect(context.conversations.get('conversation-1')?.codeWorkspaces).toEqual([mac]);
  });

  test('moves once the previous generation has settled and saved', async () => {
    const { move } = setup({
      job: { status: 'complete', metadata: { terminalPersistencePending: false } },
    });

    expect((await move({ from: [mac], to: [vm] })).statusCode).toBe(200);
  });

  test.each([
    {
      name: 'a workspace the machine does not register',
      fetchImpl: jest
        .fn()
        .mockImplementation(async () =>
          workerStatusResponse({ workspaces: [{ id: 'another-project' }] }),
        ),
      reason: 'missing',
    },
    {
      name: 'a machine that is not ready',
      fetchImpl: jest.fn().mockImplementation(async () => workerStatusResponse({ ready: false })),
      reason: 'worker_unavailable',
    },
  ])('rejects $name without persisting', async ({ fetchImpl, reason }) => {
    const { move, conversations, replaceDecision } = setup({ fetchImpl });

    const res = await move({ from: [mac], to: [vm] });

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ reason }));
    expect(replaceDecision).not.toHaveBeenCalled();
    expect(conversations.get('conversation-1')?.codeWorkspaces).toEqual([mac]);
  });

  test.each([
    {
      name: 'an environment the caller cannot access',
      body: { from: [mac], to: [{ environmentId: 'another-users-vm', workspaceId: 'root' }] },
      reason: 'invalid',
      polls: 0,
    },
    {
      name: 'a stale view of the decision',
      body: { from: [{ environmentId: 'old-vm', workspaceId: 'primary' }], to: [vm] },
      reason: 'locked',
      polls: 0,
    },
    {
      name: 'a replacement on an environment the caller cannot access',
      body: { from: [mac], to: [{ environmentId: 'mac', workspaceId: 'canary' }] },
      reason: 'invalid',
      polls: 0,
    },
  ])('rejects $name without polling any worker', async ({ body, reason, polls }) => {
    const { move, replaceDecision, fetchImpl } = setup();

    const res = await move(body);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ reason }));
    expect(fetchImpl).toHaveBeenCalledTimes(polls);
    expect(replaceDecision).not.toHaveBeenCalled();
  });

  test('keeps a decision another writer replaced while the worker was checked', async () => {
    const concurrent: StoredDecision = {
      conversationId: 'conversation-1',
      codeEnvironmentMode: 'without_attached',
    };
    const holder: { conversations?: Map<string, StoredDecision> } = {};
    const fetchImpl = jest.fn().mockImplementation(async () => {
      holder.conversations?.set('conversation-1', concurrent);
      return workerStatusResponse();
    });
    const context = setup({ fetchImpl });
    holder.conversations = context.conversations;

    const res = await context.move({ from: [mac], to: [vm] });

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ reason: 'locked' }));
    expect(context.conversations.get('conversation-1')).toEqual(concurrent);
  });

  test('refuses every move when the effective policy does not enable them', async () => {
    const { move, getConversation, replaceDecision, fetchImpl } = setup({ movesEnabled: false });

    const res = await move({ from: [mac], to: [vm] });

    expect(res.statusCode).toBe(403);
    expect(getConversation).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(replaceDecision).not.toHaveBeenCalled();
  });

  test('reports a conversation the caller does not own as not found', async () => {
    const { move, fetchImpl } = setup();

    const res = await move({ from: [mac], to: [vm] }, 'someone-elses-conversation');

    expect(res.statusCode).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

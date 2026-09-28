import { EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import {
  isImplicitStatefulCodeRouteAvailable,
  mergeAccessibleCodeEnvironments,
  resolveCodeEnvironmentDecisionVersion,
  resolveCodeEnvironmentMoveVersion,
  resolveCodeEnvironmentTransitionVersion,
  resolveCodeEnvironmentMoveCapabilities,
} from './config';

describe('resolveCodeEnvironmentDecisionVersion', () => {
  it('advertises the exact supported protocol version', () => {
    expect(resolveCodeEnvironmentDecisionVersion('1')).toBe(1);
  });

  it.each([undefined, '0', '2', '1.0', 'true'])(
    'keeps unsupported configured version %s on the legacy-safe path',
    (version) => {
      expect(resolveCodeEnvironmentDecisionVersion(version)).toBeUndefined();
    },
  );
});

describe('resolveCodeEnvironmentMoveVersion', () => {
  const withMoves = (conversationMoves?: { enabled?: boolean; allowAttachDetach?: boolean }) =>
    ({
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: { allowedEnvironments: ['user'], conversationMoves },
        },
      },
    }) as unknown as AppConfig;

  it('advertises moves only where the effective policy enables them', () => {
    expect(resolveCodeEnvironmentMoveVersion(withMoves({ enabled: true }))).toBe(1);
    expect(resolveCodeEnvironmentMoveCapabilities(withMoves({ enabled: true }))).toEqual({
      codeEnvironmentMoveVersion: 1,
      codeWorkspaceRecoveryVersion: 1,
    });
  });

  /* Attaching and leaving ship under the same policy as the move but on their own number, so a
   * client that predates them keeps reading a move version it understands. */
  it.each([undefined, false])(
    'preserves enabled move-only policy with allowAttachDetach=%s',
    (allowAttachDetach) => {
      const config = withMoves({ enabled: true, allowAttachDetach });
      expect(resolveCodeEnvironmentMoveVersion(config)).toBe(1);
      expect(resolveCodeEnvironmentTransitionVersion(config)).toBeUndefined();
    },
  );

  it('advertises attach and detach separately from the move', () => {
    expect(
      resolveCodeEnvironmentTransitionVersion(
        withMoves({ enabled: true, allowAttachDetach: true }),
      ),
    ).toBe(2);
  });

  it.each([undefined, {}, { enabled: false }])(
    'keeps attach and detach off wherever moves are off: %j',
    (conversationMoves) => {
      expect(resolveCodeEnvironmentTransitionVersion(withMoves(conversationMoves))).toBeUndefined();
    },
  );

  it.each([undefined, {}, { enabled: false }])(
    'keeps sealed decisions immovable by default: %j',
    (conversationMoves) => {
      expect(resolveCodeEnvironmentMoveVersion(withMoves(conversationMoves))).toBeUndefined();
      expect(resolveCodeEnvironmentMoveCapabilities(withMoves(conversationMoves))).toEqual({});
    },
  );

  it('keeps moves off without any stateful code configuration', () => {
    expect(resolveCodeEnvironmentMoveVersion({} as AppConfig)).toBeUndefined();
    expect(resolveCodeEnvironmentMoveVersion(undefined)).toBeUndefined();
    expect(resolveCodeEnvironmentMoveCapabilities({} as AppConfig)).toEqual({});
    expect(resolveCodeEnvironmentMoveCapabilities(undefined)).toEqual({});
  });
});

describe('isImplicitStatefulCodeRouteAvailable', () => {
  it('requires both the deployed protocol version and a non-empty managed base URL', () => {
    expect(isImplicitStatefulCodeRouteAvailable('1', 'https://code.example/v1')).toBe(true);
    expect(isImplicitStatefulCodeRouteAvailable(undefined, 'https://code.example/v1')).toBe(false);
    expect(isImplicitStatefulCodeRouteAvailable('1', '  ')).toBe(false);
  });
});

describe('mergeAccessibleCodeEnvironments', () => {
  test('adds principal environments without allowing them to shadow deployment entries', async () => {
    const appConfig = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            allowedEnvironments: ['conversation'],
            environments: [
              {
                id: 'deployment-vm',
                name: 'Deployment VM',
                type: 'attached',
                baseURL: 'https://deployment.example',
                owner: 'deployment',
                pairing: { workerId: 'deployment-worker', tokenEnv: 'CODE_ADMIN_TOKEN' },
              },
            ],
          },
        },
      },
    } as unknown as AppConfig;
    const listAccessibleConfigurations = jest.fn().mockResolvedValue([
      {
        id: 'personal-vm',
        name: 'Personal VM',
        type: 'attached',
        baseURL: 'https://retired.example',
        controlPlaneId: 'deployment-vm',
        owner: 'principal',
      },
      {
        id: 'deployment-vm',
        name: 'Shadow Attempt',
        type: 'attached',
        baseURL: 'https://shadow.example',
        controlPlaneId: 'deployment-vm',
        owner: 'principal',
      },
    ]);

    const result = await mergeAccessibleCodeEnvironments({
      appConfig,
      deploymentConfig: appConfig,
      actor: { userId: '68b2f0c498f24c1e78fa0001', role: 'USER', idOnTheSource: null },
      registry: {
        listAccessibleConfigurations,
        listRegisteredIds: jest.fn().mockResolvedValue(['personal-vm', 'deployment-vm']),
      },
    });

    expect(result).not.toBe(appConfig);
    expect(result.endpoints?.agents?.statefulCodeSessions?.environments).toEqual([
      expect.objectContaining({
        id: 'deployment-vm',
        baseURL: 'https://deployment.example',
        default: true,
      }),
      expect.objectContaining({ id: 'personal-vm', baseURL: 'https://deployment.example' }),
    ]);
    expect(appConfig.endpoints?.agents?.statefulCodeSessions?.environments).toHaveLength(1);
  });

  test('fails closed when a principal environment references a retired control plane', async () => {
    const appConfig = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            allowedEnvironments: ['conversation'],
            environments: [],
          },
        },
      },
    } as unknown as AppConfig;
    const listAccessibleConfigurations = jest.fn().mockResolvedValue([
      {
        id: 'personal-vm',
        name: 'Personal VM',
        type: 'attached',
        baseURL: 'https://retired.example',
        controlPlaneId: 'retired-plane',
        owner: 'principal',
      },
    ]);

    const result = await mergeAccessibleCodeEnvironments({
      appConfig,
      deploymentConfig: appConfig,
      actor: { userId: '68b2f0c498f24c1e78fa0001', role: 'USER', idOnTheSource: null },
      registry: {
        listAccessibleConfigurations,
        listRegisteredIds: jest.fn().mockResolvedValue(['personal-vm']),
      },
    });

    expect(result).toBe(appConfig);
  });

  test('resolves principal aliases only against the YAML deployment config', async () => {
    const deploymentConfig = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            environments: [
              {
                id: 'approved-plane',
                name: 'Approved Plane',
                type: 'attached',
                baseURL: 'https://approved.example',
                owner: 'deployment',
                pairing: { workerId: 'approved-worker', tokenEnv: 'CODE_ADMIN_TOKEN' },
              },
            ],
          },
        },
      },
    } as unknown as AppConfig;
    const appConfig = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            environments: [
              {
                id: 'approved-plane',
                name: 'Override Plane',
                type: 'attached',
                baseURL: 'https://override.example',
                owner: 'deployment',
                pairing: { workerId: 'override-worker', tokenEnv: 'OVERRIDE_TOKEN' },
                configSchema: {
                  permissions: {
                    commandExecution: { allowed: ['ask', 'deny'], default: 'ask' },
                  },
                  limits: {
                    maxCommandTimeoutMs: 120_000,
                  },
                },
              },
            ],
          },
        },
      },
    } as unknown as AppConfig;
    const input = {
      appConfig,
      deploymentConfig,
      actor: { userId: '68b2f0c498f24c1e78fa0001', role: 'USER', idOnTheSource: null },
      registry: {
        listRegisteredIds: jest.fn().mockResolvedValue(['personal-vm']),
        listAccessibleConfigurations: jest.fn().mockResolvedValue([
          {
            id: 'personal-vm',
            name: 'Personal VM',
            type: 'attached',
            baseURL: 'https://persisted.example',
            controlPlaneId: 'approved-plane',
            owner: 'principal',
            settings: { permissions: { commandExecution: 'deny' } },
          },
        ]),
      },
    };

    const result = await mergeAccessibleCodeEnvironments(input);
    const environments = result.endpoints?.agents?.statefulCodeSessions?.environments;

    expect(environments?.find((environment) => environment.id === 'personal-vm')?.baseURL).toBe(
      'https://approved.example',
    );
    expect(environments?.find((environment) => environment.id === 'personal-vm')).toMatchObject({
      configSchema: {
        permissions: {
          commandExecution: { allowed: ['ask', 'deny'], default: 'ask' },
        },
        limits: {
          maxCommandTimeoutMs: 120_000,
        },
      },
      settings: { permissions: { commandExecution: 'deny' } },
    });
  });

  test('replaces a merged override that shadows an accessible principal environment', async () => {
    const deploymentConfig = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            environments: [
              {
                id: 'approved-plane',
                name: 'Approved Plane',
                type: 'attached',
                baseURL: 'https://approved.example',
                owner: 'deployment',
                pairing: { workerId: 'approved-worker', tokenEnv: 'CODE_ADMIN_TOKEN' },
              },
            ],
          },
        },
      },
    } as unknown as AppConfig;
    const appConfig = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            environments: [
              {
                id: 'personal-vm',
                name: 'Shadow Override',
                type: 'attached',
                baseURL: 'https://shadow.example',
                owner: 'deployment',
                default: true,
                pairing: { workerId: 'shadow-worker', tokenEnv: 'SHADOW_TOKEN' },
              },
            ],
          },
        },
      },
    } as unknown as AppConfig;

    const result = await mergeAccessibleCodeEnvironments({
      appConfig,
      deploymentConfig,
      actor: { userId: '68b2f0c498f24c1e78fa0001', role: 'USER', idOnTheSource: null },
      registry: {
        listRegisteredIds: jest.fn().mockResolvedValue(['personal-vm']),
        listAccessibleConfigurations: jest.fn().mockResolvedValue([
          {
            id: 'personal-vm',
            name: 'Personal VM',
            type: 'attached',
            baseURL: 'https://persisted.example',
            controlPlaneId: 'approved-plane',
            owner: 'principal',
          },
        ]),
      },
    });
    const environments = result.endpoints?.agents?.statefulCodeSessions?.environments;

    expect(environments).toEqual([
      expect.objectContaining({
        id: 'personal-vm',
        name: 'Personal VM',
        baseURL: 'https://approved.example',
        owner: 'principal',
        default: true,
      }),
    ]);
  });

  test('suppresses a registered environment shadow after its ACL is revoked', async () => {
    const appConfig = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            environments: [
              {
                id: 'revoked-vm',
                name: 'Revoked Shadow',
                type: 'attached',
                baseURL: 'https://shadow.example',
                owner: 'deployment',
                default: true,
                pairing: { workerId: 'shadow-worker', tokenEnv: 'SHADOW_TOKEN' },
              },
              {
                id: 'unrelated-override',
                name: 'Unrelated Override',
                type: 'attached',
                baseURL: 'https://unrelated.example',
                owner: 'deployment',
                pairing: { workerId: 'other-worker', tokenEnv: 'OTHER_TOKEN' },
              },
            ],
          },
        },
      },
    } as unknown as AppConfig;

    const result = await mergeAccessibleCodeEnvironments({
      appConfig,
      deploymentConfig: {
        endpoints: {
          [EModelEndpoint.agents]: { statefulCodeSessions: { environments: [] } },
        },
      } as unknown as AppConfig,
      actor: { userId: '68b2f0c498f24c1e78fa0001', role: 'USER', idOnTheSource: null },
      registry: {
        listAccessibleConfigurations: jest.fn().mockResolvedValue([]),
        listRegisteredIds: jest.fn().mockResolvedValue(['revoked-vm']),
      },
    });

    expect(result.endpoints?.agents?.statefulCodeSessions?.environments).toEqual([
      expect.objectContaining({ id: 'unrelated-override', default: true }),
    ]);
  });

  test('preserves unrelated restrictions while failing closed to deployment environments', async () => {
    const deploymentEnvironment = {
      id: 'approved-plane',
      name: 'Approved Plane',
      type: 'attached' as const,
      baseURL: 'https://approved.example',
      owner: 'deployment' as const,
      default: true,
      pairing: { workerId: 'approved-worker', tokenEnv: 'CODE_ADMIN_TOKEN' },
    };
    const deploymentConfig = {
      interfaceConfig: { schedules: true },
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: { environments: [deploymentEnvironment] },
        },
      },
    } as unknown as AppConfig;
    const appConfig = {
      interfaceConfig: { schedules: false },
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            environments: [
              {
                id: 'principal-shadow',
                name: 'Principal Shadow',
                type: 'attached',
                baseURL: 'https://shadow.example',
                owner: 'deployment',
                default: true,
                pairing: { workerId: 'shadow-worker', tokenEnv: 'SHADOW_TOKEN' },
              },
            ],
          },
        },
      },
    } as unknown as AppConfig;

    const result = await mergeAccessibleCodeEnvironments({
      appConfig,
      deploymentConfig,
      actor: { userId: '68b2f0c498f24c1e78fa0001', role: 'USER', idOnTheSource: null },
      registry: {
        listAccessibleConfigurations: jest
          .fn()
          .mockRejectedValue(new Error('authorization unavailable')),
        listRegisteredIds: jest.fn().mockResolvedValue(['principal-shadow']),
      },
    });

    expect(result.interfaceConfig?.schedules).toBe(false);
    expect(result.endpoints?.agents?.statefulCodeSessions?.environments).toEqual([
      deploymentEnvironment,
    ]);
  });

  test.each([
    ['preserves the configured stateful deployment', 'https://stateful.example/v1', undefined],
    ['uses the principal environment without a stateful deployment', undefined, true],
  ])('%s after a pairing-only control plane', async (_name, statefulURL, expectedDefault) => {
    const originalStatefulURL = process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
    if (statefulURL == null) {
      delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
    } else {
      process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = statefulURL;
    }
    const pairingOnly = {
      id: 'self-service',
      name: 'Self-service',
      type: 'attached' as const,
      baseURL: 'https://code.example',
      owner: 'deployment' as const,
      default: true,
      pairing: { allowPrincipalWorkers: true, tokenEnv: 'CODE_ADMIN_TOKEN' },
    };
    const appConfig = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: { environments: [pairingOnly] },
        },
      },
    } as unknown as AppConfig;

    try {
      const result = await mergeAccessibleCodeEnvironments({
        appConfig,
        deploymentConfig: appConfig,
        actor: { userId: '68b2f0c498f24c1e78fa0001', role: 'USER', idOnTheSource: null },
        registry: {
          listRegisteredIds: jest.fn().mockResolvedValue(['personal-vm']),
          listAccessibleConfigurations: jest.fn().mockResolvedValue([
            {
              id: 'personal-vm',
              name: 'Personal VM',
              type: 'attached',
              baseURL: 'https://persisted.example',
              controlPlaneId: 'self-service',
              owner: 'principal',
              workerId: 'personal-worker',
            },
          ]),
        },
      });

      const environments = result.endpoints?.agents?.statefulCodeSessions?.environments;
      expect(environments?.find((environment) => environment.id === 'personal-vm')).toEqual(
        expect.objectContaining({ controlPlaneId: 'self-service', baseURL: pairingOnly.baseURL }),
      );
      expect(environments?.find((environment) => environment.id === 'self-service')?.default).toBe(
        false,
      );
      expect(environments?.find((environment) => environment.id === 'personal-vm')?.default).toBe(
        expectedDefault,
      );
    } finally {
      if (originalStatefulURL == null) {
        delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
      } else {
        process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = originalStatefulURL;
      }
    }
  });
});

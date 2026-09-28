import { Types } from 'mongoose';
import {
  AuthType,
  AgentCapabilities,
  EModelEndpoint,
  PrincipalType,
  defaultAgentCapabilities,
} from 'librechat-data-provider';

import type { AppConfig, IConfig } from '@librechat/data-schemas';
import type { AppConfigServiceDeps } from '~/app/service';
import type { EndpointsConfigDeps } from './endpoints';
import type { ServerRequest } from '~/types';

import { createEndpointsConfigService } from './endpoints';
import { createAppConfigService } from '~/app/service';

function appConfig(partial: Record<string, unknown>): AppConfig {
  return partial as unknown as AppConfig;
}

function configDoc(partial: Record<string, unknown>): IConfig {
  return partial as unknown as IConfig;
}

function createAppConfigCache() {
  const store = new Map<string, unknown>();
  return {
    get: jest.fn((key: string) => Promise.resolve(store.get(key))),
    set: jest.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve(undefined);
    }),
    delete: jest.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(true);
    }),
  };
}

type ConfigPrincipals = NonNullable<Parameters<AppConfigServiceDeps['getApplicableConfigs']>[0]>;

function createMockDeps(overrides: Partial<EndpointsConfigDeps> = {}): EndpointsConfigDeps {
  return {
    getAppConfig: jest.fn().mockResolvedValue(appConfig({ endpoints: {} })),
    loadDefaultEndpointsConfig: jest.fn().mockResolvedValue({
      [EModelEndpoint.openAI]: { userProvide: false, order: 0 },
    }),
    loadCustomEndpointsConfig: jest.fn().mockReturnValue(undefined),
    ...overrides,
  };
}

type TestRequestOverrides = {
  body?: Partial<ServerRequest['body']>;
  config?: AppConfig;
  user?: { id?: string; role?: string; tenantId?: string };
};

function fakeReq(overrides: TestRequestOverrides = {}): ServerRequest {
  return { user: { id: 'u1', role: 'USER' }, ...overrides } as ServerRequest;
}

describe('createEndpointsConfigService', () => {
  describe('getEndpointsConfig', () => {
    it('merges default and custom endpoints', async () => {
      const deps = createMockDeps({
        loadDefaultEndpointsConfig: jest.fn().mockResolvedValue({
          [EModelEndpoint.openAI]: { userProvide: false, order: 0 },
        }),
        loadCustomEndpointsConfig: jest.fn().mockReturnValue({
          myCustom: { userProvide: true },
        }),
      });
      const { getEndpointsConfig } = createEndpointsConfigService(deps);
      const result = await getEndpointsConfig(fakeReq());

      expect(result?.[EModelEndpoint.openAI]).toBeDefined();
      expect(result?.myCustom).toBeDefined();
    });

    it('adds azureOpenAI when configured', async () => {
      const deps = createMockDeps({
        getAppConfig: jest.fn().mockResolvedValue(
          appConfig({
            endpoints: { [EModelEndpoint.azureOpenAI]: { modelNames: ['gpt-4'] } },
          }),
        ),
      });
      const { getEndpointsConfig } = createEndpointsConfigService(deps);
      const result = await getEndpointsConfig(fakeReq());

      expect(result?.[EModelEndpoint.azureOpenAI]).toEqual(
        expect.objectContaining({ userProvide: false }),
      );
    });

    it('adds azureAssistants when azure has assistants config', async () => {
      const deps = createMockDeps({
        getAppConfig: jest.fn().mockResolvedValue(
          appConfig({
            endpoints: { [EModelEndpoint.azureOpenAI]: { assistants: true } },
          }),
        ),
      });
      const { getEndpointsConfig } = createEndpointsConfigService(deps);
      const result = await getEndpointsConfig(fakeReq());

      expect(result?.[EModelEndpoint.azureAssistants]).toEqual(
        expect.objectContaining({ userProvide: false }),
      );
    });

    it('enables anthropic when vertex AI is configured', async () => {
      const deps = createMockDeps({
        getAppConfig: jest.fn().mockResolvedValue(
          appConfig({
            endpoints: { [EModelEndpoint.anthropic]: { vertexConfig: { enabled: true } } },
          }),
        ),
      });
      const { getEndpointsConfig } = createEndpointsConfigService(deps);
      const result = await getEndpointsConfig(fakeReq());

      expect(result?.[EModelEndpoint.anthropic]).toEqual(
        expect.objectContaining({ userProvide: false }),
      );
    });

    it('merges assistants config with version coercion', async () => {
      const deps = createMockDeps({
        loadDefaultEndpointsConfig: jest.fn().mockResolvedValue({
          [EModelEndpoint.assistants]: { userProvide: false, order: 0 },
        }),
        getAppConfig: jest.fn().mockResolvedValue(
          appConfig({
            endpoints: {
              [EModelEndpoint.assistants]: {
                disableBuilder: true,
                capabilities: [AgentCapabilities.execute_code],
                version: 2,
              },
            },
          }),
        ),
      });
      const { getEndpointsConfig } = createEndpointsConfigService(deps);
      const result = await getEndpointsConfig(fakeReq());
      const assistants = result?.[EModelEndpoint.assistants];

      expect(assistants?.version).toBe('2');
      expect(assistants?.disableBuilder).toBe(true);
      expect(assistants?.capabilities).toEqual([AgentCapabilities.execute_code]);
    });

    it('merges agents config with allowedProviders', async () => {
      const deps = createMockDeps({
        loadDefaultEndpointsConfig: jest.fn().mockResolvedValue({
          [EModelEndpoint.agents]: { userProvide: false, order: 0 },
        }),
        getAppConfig: jest.fn().mockResolvedValue(
          appConfig({
            endpoints: {
              [EModelEndpoint.agents]: {
                allowedProviders: ['openAI', 'anthropic'],
                capabilities: [AgentCapabilities.execute_code],
                maxSubagents: 20,
              },
            },
          }),
        ),
      });
      const { getEndpointsConfig } = createEndpointsConfigService(deps);
      const result = await getEndpointsConfig(fakeReq());

      expect(result?.[EModelEndpoint.agents]?.allowedProviders).toEqual(['openAI', 'anthropic']);
      expect(result?.[EModelEndpoint.agents]?.maxSubagents).toBe(20);
    });

    it.each([true, false])(
      'exposes file sharing policy to the agent builder when enabled=%s',
      async (enabled) => {
        const fileSharing = {
          enabled,
          allowSiblingSharing: false,
          maxFiles: 100,
          ttlMs: 3_600_000,
        };
        const deps = createMockDeps({
          loadDefaultEndpointsConfig: jest.fn().mockResolvedValue({
            [EModelEndpoint.agents]: { userProvide: false, order: 0 },
          }),
          getAppConfig: jest
            .fn()
            .mockResolvedValue(
              appConfig({ endpoints: { [EModelEndpoint.agents]: { fileSharing } } }),
            ),
        });
        const { getEndpointsConfig } = createEndpointsConfigService(deps);
        const result = await getEndpointsConfig(fakeReq());

        expect(result?.[EModelEndpoint.agents]?.fileSharing).toEqual(fileSharing);
      },
    );

    it('exposes the deployment stateful environment allowlist', async () => {
      const deps = createMockDeps({
        loadDefaultEndpointsConfig: jest.fn().mockResolvedValue({
          [EModelEndpoint.agents]: { userProvide: false, order: 0 },
        }),
        getAppConfig: jest.fn().mockResolvedValue(
          appConfig({
            endpoints: {
              [EModelEndpoint.agents]: {
                toolApproval: { enabled: false },
                statefulCodeSessions: {
                  allowedEnvironments: ['user', 'agent-user'],
                  environments: [
                    {
                      id: 'attached-vm',
                      name: 'Attached VM',
                      type: 'attached',
                      baseURL: 'https://internal-code.example.com/v1',
                      workerId: 'private-worker-route',
                      pairing: {
                        workerId: 'private-worker-route',
                        tokenEnv: 'CODE_BRIDGE_ADMIN_TOKEN',
                      },
                      configSchema: {
                        permissions: {
                          commandExecution: { allowed: ['ask', 'deny'], default: 'ask' },
                        },
                      },
                      default: true,
                    },
                  ],
                },
              },
            },
          }),
        ),
      });
      const { getEndpointsConfig } = createEndpointsConfigService(deps);

      const result = await getEndpointsConfig(fakeReq());

      expect(result?.[EModelEndpoint.agents]?.statefulCodeSessions).toEqual({
        allowedEnvironments: ['user', 'agent-user'],
        approvalsEnabled: false,
        approvalModes: [],
        environments: [
          {
            id: 'attached-vm',
            name: 'Attached VM',
            type: 'attached',
            default: true,
            configSchema: {
              permissions: {
                commandExecution: { allowed: ['ask', 'deny'], default: 'ask' },
              },
            },
          },
        ],
      });
    });

    it('does not expose a pairing-only control plane as an execution environment', async () => {
      const deps = createMockDeps({
        loadDefaultEndpointsConfig: jest.fn().mockResolvedValue({
          [EModelEndpoint.agents]: { userProvide: false, order: 0 },
        }),
        getAppConfig: jest.fn().mockResolvedValue(
          appConfig({
            endpoints: {
              [EModelEndpoint.agents]: {
                statefulCodeSessions: {
                  allowedEnvironments: ['user'],
                  environments: [
                    {
                      id: 'self-service',
                      name: 'Self-service',
                      type: 'attached',
                      baseURL: 'https://internal-code.example.com/v1',
                      pairing: {
                        allowPrincipalWorkers: true,
                        tokenEnv: 'CODE_BRIDGE_ADMIN_TOKEN',
                      },
                    },
                  ],
                },
              },
            },
          }),
        ),
      });
      const { getEndpointsConfig } = createEndpointsConfigService(deps);

      const result = await getEndpointsConfig(fakeReq());

      expect(result?.[EModelEndpoint.agents]?.statefulCodeSessions).toEqual({
        allowedEnvironments: ['user'],
        approvalsEnabled: true,
        approvalModes: ['ask', 'acceptEdits', 'fullAccess'],
        environments: [],
      });
    });

    it.each([
      [{ enabled: true }, ['ask']],
      [{ enabled: true, mode: 'default' }, ['ask']],
      [{ enabled: true, mode: 'dontAsk' }, ['ask']],
      [{ enabled: true, mode: 'bypass' }, ['ask', 'acceptEdits', 'fullAccess']],
    ])('exposes approval modes allowed by endpoint policy %p', async (toolApproval, expected) => {
      const deps = createMockDeps({
        loadDefaultEndpointsConfig: jest.fn().mockResolvedValue({
          [EModelEndpoint.agents]: { userProvide: false, order: 0 },
        }),
        getAppConfig: jest.fn().mockResolvedValue(
          appConfig({
            endpoints: {
              [EModelEndpoint.agents]: {
                toolApproval,
                statefulCodeSessions: {
                  allowedEnvironments: ['user'],
                  environments: [],
                },
              },
            },
          }),
        ),
      });
      const { getEndpointsConfig } = createEndpointsConfigService(deps);

      const result = await getEndpointsConfig(fakeReq());

      expect(result?.[EModelEndpoint.agents]?.statefulCodeSessions?.approvalModes).toEqual(
        expected,
      );
    });

    it('merges bedrock availableRegions', async () => {
      const deps = createMockDeps({
        loadDefaultEndpointsConfig: jest.fn().mockResolvedValue({
          [EModelEndpoint.bedrock]: { userProvide: false, order: 0 },
        }),
        getAppConfig: jest.fn().mockResolvedValue(
          appConfig({
            endpoints: {
              [EModelEndpoint.bedrock]: { availableRegions: ['us-east-1', 'eu-west-1'] },
            },
          }),
        ),
      });
      const { getEndpointsConfig } = createEndpointsConfigService(deps);
      const result = await getEndpointsConfig(fakeReq());

      expect(result?.[EModelEndpoint.bedrock]?.availableRegions).toEqual([
        'us-east-1',
        'eu-west-1',
      ]);
    });

    it('exposes Bedrock user-provided credential options', async () => {
      const previousEnv = {
        BEDROCK_AWS_ACCESS_KEY_ID: process.env.BEDROCK_AWS_ACCESS_KEY_ID,
        BEDROCK_AWS_SECRET_ACCESS_KEY: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY,
        BEDROCK_AWS_SESSION_TOKEN: process.env.BEDROCK_AWS_SESSION_TOKEN,
        BEDROCK_AWS_BEARER_TOKEN: process.env.BEDROCK_AWS_BEARER_TOKEN,
      };

      process.env.BEDROCK_AWS_ACCESS_KEY_ID = AuthType.USER_PROVIDED;
      process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = AuthType.USER_PROVIDED;
      process.env.BEDROCK_AWS_SESSION_TOKEN = AuthType.USER_PROVIDED;
      process.env.BEDROCK_AWS_BEARER_TOKEN = AuthType.USER_PROVIDED;

      try {
        const deps = createMockDeps({
          loadDefaultEndpointsConfig: jest.fn().mockResolvedValue({
            [EModelEndpoint.bedrock]: { userProvide: false, order: 0 },
          }),
        });
        const { getEndpointsConfig } = createEndpointsConfigService(deps);
        const result = await getEndpointsConfig(fakeReq());

        expect(result?.[EModelEndpoint.bedrock]).toEqual(
          expect.objectContaining({
            userProvideAccessKeyId: true,
            userProvideSecretAccessKey: true,
            userProvideSessionToken: true,
            userProvideBearerToken: true,
          }),
        );
      } finally {
        Object.entries(previousEnv).forEach(([key, value]) => {
          if (value == null) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        });
      }
    });

    it('uses req.config when available instead of calling getAppConfig', async () => {
      const mockGetAppConfig = jest.fn();
      const deps = createMockDeps({ getAppConfig: mockGetAppConfig });
      const { getEndpointsConfig } = createEndpointsConfigService(deps);

      await getEndpointsConfig(fakeReq({ config: appConfig({ endpoints: {} }) }));

      expect(mockGetAppConfig).not.toHaveBeenCalled();
    });

    it('passes userId when resolving scoped endpoint config', async () => {
      const mockGetAppConfig = jest.fn().mockResolvedValue(appConfig({ endpoints: {} }));
      const deps = createMockDeps({ getAppConfig: mockGetAppConfig });
      const { getEndpointsConfig } = createEndpointsConfigService(deps);

      await getEndpointsConfig(fakeReq({ user: { id: 'u1', role: 'USER', tenantId: 'tenant-a' } }));

      expect(mockGetAppConfig).toHaveBeenCalledWith({
        role: 'USER',
        userId: 'u1',
        idOnTheSource: undefined,
        tenantId: 'tenant-a',
      });
    });

    it('exposes custom endpoints from group-scoped overrides for grouped users', async () => {
      const groupId = new Types.ObjectId('6a0aea2172e2d59d4658c9d2');
      const getUserPrincipals = jest.fn().mockResolvedValue([
        { principalType: PrincipalType.ROLE, principalId: 'USER' },
        { principalType: PrincipalType.USER, principalId: 'u1' },
        { principalType: PrincipalType.GROUP, principalId: groupId },
      ]);
      const getApplicableConfigs = jest.fn((principals: ConfigPrincipals = []) =>
        Promise.resolve(
          principals.some(
            (principal) =>
              principal.principalType === PrincipalType.GROUP &&
              String(principal.principalId) === groupId.toString(),
          )
            ? [
                configDoc({
                  principalType: PrincipalType.GROUP,
                  principalId: groupId,
                  priority: 20,
                  isActive: true,
                  overrides: {
                    endpoints: {
                      custom: [
                        {
                          name: 'FOO',
                          apiKey: '${FOO_KEY}',
                          baseURL: '${FOO_URL}',
                          models: { fetch: true },
                        },
                      ],
                    },
                  },
                }),
              ]
            : [],
        ),
      );
      const { getAppConfig } = createAppConfigService({
        loadBaseConfig: jest.fn().mockResolvedValue(appConfig({ endpoints: {} })),
        setCachedTools: jest.fn().mockResolvedValue(undefined),
        getCache: jest.fn().mockReturnValue(createAppConfigCache()),
        cacheKeys: { APP_CONFIG: 'app_config' },
        getApplicableConfigs,
        getUserPrincipals,
      });
      const { getEndpointsConfig } = createEndpointsConfigService({
        getAppConfig,
        loadDefaultEndpointsConfig: jest.fn().mockResolvedValue({}),
      });

      const result = await getEndpointsConfig(fakeReq({ user: { id: 'u1', role: 'USER' } }));

      expect(getUserPrincipals).toHaveBeenCalledWith({
        userId: 'u1',
        role: 'USER',
      });
      expect(getApplicableConfigs).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ principalType: PrincipalType.GROUP, principalId: groupId }),
        ]),
      );
      expect(result?.FOO).toEqual(expect.objectContaining({ type: EModelEndpoint.custom }));
    });
  });

  describe('checkCapability', () => {
    it('returns true when agents endpoint has the requested capability', async () => {
      const deps = createMockDeps({
        loadDefaultEndpointsConfig: jest.fn().mockResolvedValue({
          [EModelEndpoint.agents]: { userProvide: false, order: 0 },
        }),
        getAppConfig: jest.fn().mockResolvedValue(
          appConfig({
            endpoints: {
              [EModelEndpoint.agents]: {
                capabilities: [AgentCapabilities.execute_code],
              },
            },
          }),
        ),
      });
      const { checkCapability } = createEndpointsConfigService(deps);

      const result = await checkCapability(
        fakeReq({ body: { endpoint: EModelEndpoint.agents } }),
        AgentCapabilities.execute_code,
      );

      expect(result).toBe(true);
    });

    it('returns false when agents endpoint lacks the requested capability', async () => {
      const deps = createMockDeps({
        loadDefaultEndpointsConfig: jest.fn().mockResolvedValue({
          [EModelEndpoint.agents]: { userProvide: false, order: 0 },
        }),
        getAppConfig: jest.fn().mockResolvedValue(
          appConfig({
            endpoints: {
              [EModelEndpoint.agents]: {
                capabilities: [AgentCapabilities.execute_code],
              },
            },
          }),
        ),
      });
      const { checkCapability } = createEndpointsConfigService(deps);

      const result = await checkCapability(
        fakeReq({ body: { endpoint: EModelEndpoint.agents } }),
        AgentCapabilities.file_search,
      );

      expect(result).toBe(false);
    });

    it('falls back to defaultAgentCapabilities for non-agents endpoints', async () => {
      const deps = createMockDeps();
      const { checkCapability } = createEndpointsConfigService(deps);

      const result = await checkCapability(
        fakeReq({ body: { endpoint: EModelEndpoint.openAI } }),
        defaultAgentCapabilities[0],
      );

      expect(result).toBe(true);
    });
  });
});

describe('defaultAgentCapabilities', () => {
  it('includes AgentCapabilities.skills so skills are enabled by default', () => {
    expect(defaultAgentCapabilities).toContain(AgentCapabilities.skills);
  });
});

import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import {
  AuthType,
  EModelEndpoint,
  BEDROCK_OUTPUT_128K_BETA,
  BEDROCK_FINE_GRAINED_TOOL_STREAMING_BETA,
} from 'librechat-data-provider';
import type { BaseInitializeParams, BedrockLLMConfigResult } from '~/types';
import { initializeBedrock } from './initialize';
import { checkUserKeyExpiry } from '~/utils';

jest.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: jest.fn().mockImplementation((proxy) => ({ proxy })),
}));

jest.mock('@smithy/node-http-handler', () => ({
  NodeHttpHandler: jest.fn().mockImplementation((options) => ({ ...options })),
}));

jest.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: jest.fn().mockImplementation((config) => {
    const provider = jest.fn();
    return Object.assign(provider, { config });
  }),
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation((config) => ({
    ...config,
    _isBedrockClient: true,
  })),
}));

jest.mock('~/utils', () => ({
  checkUserKeyExpiry: jest.fn(),
}));

const mockedCheckUserKeyExpiry = jest.mocked(checkUserKeyExpiry);
const mockedFromNodeProviderChain = jest.mocked(fromNodeProviderChain);
const BEDROCK_CLAUDE_4_BETAS = [BEDROCK_OUTPUT_128K_BETA, BEDROCK_FINE_GRAINED_TOOL_STREAMING_BETA];

const createMockParams = (
  overrides: Partial<{
    config: Record<string, unknown>;
    body: Record<string, unknown>;
    user: { id: string };
    model_parameters: Record<string, unknown>;
    env: Record<string, string | undefined>;
  }> = {},
): BaseInitializeParams => {
  const mockDb = {
    getUserKey: jest.fn().mockResolvedValue(
      JSON.stringify({
        accessKeyId: 'user-access-key',
        secretAccessKey: 'user-secret-key',
      }),
    ),
  };

  return {
    req: {
      config: overrides.config ?? {},
      body: overrides.body ?? {},
      user: overrides.user ?? { id: 'test-user-id' },
    },
    endpoint: EModelEndpoint.bedrock,
    model_parameters: overrides.model_parameters ?? { model: 'anthropic.claude-3-sonnet' },
    db: mockDb,
  } as unknown as BaseInitializeParams;
};

describe('initializeBedrock', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.BEDROCK_AWS_BEARER_TOKEN;
    delete process.env.BEDROCK_AWS_PROFILE;
    delete process.env.BEDROCK_AWS_SESSION_TOKEN;
    delete process.env.BEDROCK_REVERSE_PROXY;
    delete process.env.PROXY;
    delete process.env.proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.NO_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.no_proxy;
    process.env.BEDROCK_AWS_ACCESS_KEY_ID = 'test-access-key';
    process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = 'test-secret-key';
    process.env.BEDROCK_AWS_DEFAULT_REGION = 'us-east-1';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Basic Configuration', () => {
    it('should create a basic configuration with credentials from environment', async () => {
      const params = createMockParams();
      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig).toHaveProperty('credentials');
      expect(result.llmConfig.credentials).toEqual({
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
      });
      expect(result.llmConfig).toHaveProperty('model', 'anthropic.claude-3-sonnet');
    });

    it('should include region from environment', async () => {
      const params = createMockParams();
      const result = await initializeBedrock(params);

      expect(result.llmConfig).toHaveProperty('region', 'us-east-1');
    });

    it('should handle model_parameters', async () => {
      const params = createMockParams({
        model_parameters: {
          model: 'anthropic.claude-3-opus',
          temperature: 0.7,
          maxTokens: 4096,
        },
      });
      const result = await initializeBedrock(params);

      expect(result.llmConfig).toHaveProperty('model', 'anthropic.claude-3-opus');
      expect(result.llmConfig).toHaveProperty('temperature', 0.7);
      expect(result.llmConfig).toHaveProperty('maxTokens', 4096);
    });

    it('should handle session token when provided', async () => {
      process.env.BEDROCK_AWS_SESSION_TOKEN = 'test-session-token';
      const params = createMockParams();
      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig.credentials).toEqual({
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
        sessionToken: 'test-session-token',
      });
    });

    it('should pass BEDROCK_AWS_BEARER_TOKEN as a BedrockRuntimeClient token', async () => {
      process.env.BEDROCK_AWS_BEARER_TOKEN = 'test-bedrock-api-key';
      const params = createMockParams();
      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig).toHaveProperty('client');
      expect(result.llmConfig.client).toHaveProperty('_isBedrockClient', true);
      expect(result.llmConfig.client).toHaveProperty('token', {
        token: 'test-bedrock-api-key',
      });
      expect(result.llmConfig.client).toHaveProperty('authSchemePreference', ['httpBearerAuth']);
      expect(result.llmConfig).not.toHaveProperty('credentials');
      expect(result.llmConfig).not.toHaveProperty('profile');
    });

    it('should pass AWS profile to ChatBedrockConverse when static credentials are unset', async () => {
      delete process.env.BEDROCK_AWS_ACCESS_KEY_ID;
      delete process.env.BEDROCK_AWS_SECRET_ACCESS_KEY;
      process.env.BEDROCK_AWS_PROFILE = 'dev-profile';
      const params = createMockParams();
      const result = await initializeBedrock(params);

      expect(result.llmConfig).toHaveProperty('profile', 'dev-profile');
      expect(result.llmConfig).not.toHaveProperty('credentials');
      expect(result.llmConfig).not.toHaveProperty('client');
      expect(mockedFromNodeProviderChain).not.toHaveBeenCalled();
    });
  });

  describe('GuardrailConfig', () => {
    it('should apply guardrailConfig from backend config', async () => {
      const guardrailConfig = {
        guardrailIdentifier: 'test-guardrail-id',
        guardrailVersion: '1',
        trace: 'enabled' as const,
        streamProcessingMode: 'async',
      };

      const params = createMockParams({
        config: {
          endpoints: {
            [EModelEndpoint.bedrock]: {
              guardrailConfig,
            },
          },
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig).toHaveProperty('guardrailConfig');
      expect(result.llmConfig.guardrailConfig).toEqual(guardrailConfig);
    });

    it('should NOT include guardrailConfig when not configured', async () => {
      const params = createMockParams({
        config: {
          endpoints: {
            [EModelEndpoint.bedrock]: {},
          },
        },
      });

      const result = await initializeBedrock(params);

      expect(result.llmConfig).not.toHaveProperty('guardrailConfig');
    });

    it('should apply guardrailConfig regardless of model_parameters', async () => {
      const guardrailConfig = {
        guardrailIdentifier: 'admin-guardrail',
        guardrailVersion: 'DRAFT',
      };

      const params = createMockParams({
        config: {
          endpoints: {
            [EModelEndpoint.bedrock]: {
              guardrailConfig,
            },
          },
        },
        model_parameters: {
          model: 'anthropic.claude-3-sonnet',
          temperature: 0.5,
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig.guardrailConfig).toEqual(guardrailConfig);
      expect(result.llmConfig).toHaveProperty('temperature', 0.5);
    });

    it('should handle guardrailConfig with enabled_full trace', async () => {
      const guardrailConfig = {
        guardrailIdentifier: 'compliance-guardrail',
        guardrailVersion: '2',
        trace: 'enabled_full' as const,
      };

      const params = createMockParams({
        config: {
          endpoints: {
            [EModelEndpoint.bedrock]: {
              guardrailConfig,
            },
          },
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig.guardrailConfig).toEqual(guardrailConfig);
      expect(result.llmConfig.guardrailConfig?.trace).toBe('enabled_full');
    });

    it.each([
      {
        description: 'guardrailIdentifier only',
        envVars: { GUARDRAIL_ID: 'gr-abc123xyz' },
        input: {
          guardrailIdentifier: '${GUARDRAIL_ID}',
          guardrailVersion: '1',
        },
        expected: {
          guardrailIdentifier: 'gr-abc123xyz',
          guardrailVersion: '1',
        },
      },
      {
        description: 'guardrailVersion only',
        envVars: { GUARDRAIL_VERSION: 'DRAFT' },
        input: {
          guardrailIdentifier: 'static-guardrail-id',
          guardrailVersion: '${GUARDRAIL_VERSION}',
        },
        expected: {
          guardrailIdentifier: 'static-guardrail-id',
          guardrailVersion: 'DRAFT',
        },
      },
      {
        description: 'both guardrailIdentifier and guardrailVersion',
        envVars: { PROD_GUARDRAIL_ID: 'gr-production-123', PROD_GUARDRAIL_VERSION: '5' },
        input: {
          guardrailIdentifier: '${PROD_GUARDRAIL_ID}',
          guardrailVersion: '${PROD_GUARDRAIL_VERSION}',
          trace: 'enabled' as const,
        },
        expected: {
          guardrailIdentifier: 'gr-production-123',
          guardrailVersion: '5',
          trace: 'enabled',
        },
      },
      {
        description: 'direct values when no env variable syntax is used',
        envVars: {},
        input: {
          guardrailIdentifier: 'direct-guardrail-id',
          guardrailVersion: '3',
        },
        expected: {
          guardrailIdentifier: 'direct-guardrail-id',
          guardrailVersion: '3',
        },
      },
      {
        description: 'fallback to original string when env variable is not set',
        envVars: {},
        deleteEnvVars: ['NONEXISTENT_GUARDRAIL_ID'],
        input: {
          guardrailIdentifier: '${NONEXISTENT_GUARDRAIL_ID}',
          guardrailVersion: '1',
        },
        expected: {
          guardrailIdentifier: '${NONEXISTENT_GUARDRAIL_ID}',
          guardrailVersion: '1',
        },
      },
      {
        description: 'env variable with whitespace around it',
        envVars: { TRIMMED_GUARDRAIL_ID: 'gr-trimmed-123' },
        input: {
          guardrailIdentifier: '  ${TRIMMED_GUARDRAIL_ID}  ',
          guardrailVersion: '2',
        },
        expected: {
          guardrailIdentifier: 'gr-trimmed-123',
          guardrailVersion: '2',
        },
      },
      {
        description: 'preserve trace field when resolving env variables',
        envVars: { GUARDRAIL_WITH_TRACE: 'gr-with-trace' },
        input: {
          guardrailIdentifier: '${GUARDRAIL_WITH_TRACE}',
          guardrailVersion: '1',
          trace: 'enabled_full' as const,
        },
        expected: {
          guardrailIdentifier: 'gr-with-trace',
          guardrailVersion: '1',
          trace: 'enabled_full',
        },
      },
    ])(
      'should resolve environment variables: $description',
      async ({ envVars, deleteEnvVars, input, expected }) => {
        // Set up environment variables
        Object.entries(envVars).forEach(([key, value]) => {
          process.env[key] = value;
        });

        // Delete specified environment variables
        deleteEnvVars?.forEach((key) => {
          delete process.env[key];
        });

        const params = createMockParams({
          config: {
            endpoints: {
              [EModelEndpoint.bedrock]: {
                guardrailConfig: input,
              },
            },
          },
        });

        const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

        expect(result.llmConfig.guardrailConfig).toEqual(expected);
      },
    );
  });

  describe('Proxy Configuration', () => {
    it('should create BedrockRuntimeClient with proxy when PROXY is set', async () => {
      process.env.PROXY = 'http://proxy:8080';
      const params = createMockParams();
      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig).toHaveProperty('client');
      expect(result.llmConfig.client).toHaveProperty('_isBedrockClient', true);
      expect(result.llmConfig).not.toHaveProperty('credentials');
    });

    it('should include reverse proxy endpoint when BEDROCK_REVERSE_PROXY is set with PROXY', async () => {
      process.env.PROXY = 'http://proxy:8080';
      process.env.BEDROCK_REVERSE_PROXY = 'custom-bedrock-endpoint.com';
      const params = createMockParams();
      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig).toHaveProperty('client');
      expect(result.llmConfig.client).toHaveProperty(
        'endpoint',
        'https://custom-bedrock-endpoint.com',
      );
    });

    it('should honor NO_PROXY for reverse proxy endpoints when PROXY is set', async () => {
      process.env.PROXY = 'http://proxy:8080';
      process.env.NO_PROXY = 'custom-bedrock-endpoint.com';
      process.env.BEDROCK_REVERSE_PROXY = 'custom-bedrock-endpoint.com';
      const params = createMockParams();
      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig).not.toHaveProperty('client');
      expect(result.llmConfig).toHaveProperty('endpointHost', 'custom-bedrock-endpoint.com');
    });

    it('should use AWS profile provider when PROXY is set and static credentials are unset', async () => {
      delete process.env.BEDROCK_AWS_ACCESS_KEY_ID;
      delete process.env.BEDROCK_AWS_SECRET_ACCESS_KEY;
      process.env.BEDROCK_AWS_PROFILE = 'dev-profile';
      process.env.PROXY = 'http://proxy:8080';
      const params = createMockParams();
      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(mockedFromNodeProviderChain).toHaveBeenCalledWith({ profile: 'dev-profile' });
      expect(result.llmConfig).toHaveProperty('client');
      expect(result.llmConfig).not.toHaveProperty('credentials');

      const client = result.llmConfig.client as unknown as Record<string, unknown>;
      const credentials = client.credentials as { config?: Record<string, string> };
      expect(credentials.config).toEqual({ profile: 'dev-profile' });
    });
  });

  describe('Reverse Proxy Configuration', () => {
    it('should set endpointHost when BEDROCK_REVERSE_PROXY is set without PROXY', async () => {
      process.env.BEDROCK_REVERSE_PROXY = 'reverse-proxy.example.com';
      const params = createMockParams();
      const result = await initializeBedrock(params);

      expect(result.llmConfig).toHaveProperty('endpointHost', 'reverse-proxy.example.com');
      expect(result.llmConfig).not.toHaveProperty('client');
    });
  });

  describe('User-Provided Credentials', () => {
    it('should fetch credentials from database when user-provided', async () => {
      process.env.BEDROCK_AWS_ACCESS_KEY_ID = AuthType.USER_PROVIDED;
      process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = AuthType.USER_PROVIDED;
      const params = createMockParams({
        body: { key: '2024-12-31T23:59:59Z' },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(params.db.getUserKey).toHaveBeenCalledWith({
        userId: 'test-user-id',
        name: EModelEndpoint.bedrock,
      });
      expect(result.llmConfig.credentials).toEqual({
        accessKeyId: 'user-access-key',
        secretAccessKey: 'user-secret-key',
      });
    });

    it('should check key expiry for user-provided credentials', async () => {
      process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = AuthType.USER_PROVIDED;
      const expiresAt = '2024-12-31T23:59:59Z';
      const params = createMockParams({
        body: { key: expiresAt },
      });

      await initializeBedrock(params);

      expect(mockedCheckUserKeyExpiry).toHaveBeenCalledWith(expiresAt, EModelEndpoint.bedrock);
    });

    it('should fetch a user-provided Bedrock API key from database', async () => {
      process.env.BEDROCK_AWS_BEARER_TOKEN = AuthType.USER_PROVIDED;
      const params = createMockParams();
      (params.db.getUserKey as jest.Mock).mockResolvedValue(
        JSON.stringify({
          apiKey: JSON.stringify({
            bearerToken: 'user-bedrock-api-key',
          }),
        }),
      );

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(params.db.getUserKey).toHaveBeenCalledWith({
        userId: 'test-user-id',
        name: EModelEndpoint.bedrock,
      });
      expect(result.llmConfig).toHaveProperty('client');
      expect(result.llmConfig.client).toHaveProperty('token', {
        token: 'user-bedrock-api-key',
      });
      expect(result.llmConfig.client).toHaveProperty('authSchemePreference', ['httpBearerAuth']);
      expect(result.llmConfig).not.toHaveProperty('credentials');
    });

    it('should reject a non-string user-provided Bedrock API key', async () => {
      process.env.BEDROCK_AWS_BEARER_TOKEN = AuthType.USER_PROVIDED;
      process.env.BEDROCK_AWS_ACCESS_KEY_ID = AuthType.USER_PROVIDED;
      process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = AuthType.USER_PROVIDED;
      const params = createMockParams();
      (params.db.getUserKey as jest.Mock).mockResolvedValue(
        JSON.stringify({
          apiKey: JSON.stringify({
            bearerToken: {},
            accessKeyId: 'user-access-key',
            secretAccessKey: 'user-secret-key',
          }),
        }),
      );

      await expect(initializeBedrock(params)).rejects.toThrow(
        'Bedrock credentials not provided. Please provide them again.',
      );
    });

    it('should not use stored access keys when only bearer token mode is configured', async () => {
      process.env.BEDROCK_AWS_BEARER_TOKEN = AuthType.USER_PROVIDED;
      const params = createMockParams();

      await expect(initializeBedrock(params)).rejects.toThrow(
        'Bedrock credentials not provided. Please provide them again.',
      );
    });

    it('should merge user-provided access key ID with static secret access key', async () => {
      process.env.BEDROCK_AWS_ACCESS_KEY_ID = AuthType.USER_PROVIDED;
      process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = 'static-secret-key';
      const params = createMockParams();
      (params.db.getUserKey as jest.Mock).mockResolvedValue(
        JSON.stringify({
          apiKey: JSON.stringify({
            accessKeyId: 'user-access-key',
            bearerToken: 'ignored-bedrock-api-key',
          }),
        }),
      );

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig.credentials).toEqual({
        accessKeyId: 'user-access-key',
        secretAccessKey: 'static-secret-key',
      });
      expect(result.llmConfig).not.toHaveProperty('client');
    });

    it('should reject non-string user-provided access key values', async () => {
      process.env.BEDROCK_AWS_ACCESS_KEY_ID = AuthType.USER_PROVIDED;
      process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = AuthType.USER_PROVIDED;
      const params = createMockParams();
      (params.db.getUserKey as jest.Mock).mockResolvedValue(
        JSON.stringify({
          apiKey: JSON.stringify({
            accessKeyId: {},
            secretAccessKey: 'user-secret-key',
          }),
        }),
      );

      await expect(initializeBedrock(params)).rejects.toThrow(
        'Bedrock credentials not provided. Please provide them again.',
      );
    });
  });

  describe('Credentials Edge Cases', () => {
    it('should set credentials to undefined when access key and secret are empty', async () => {
      process.env.BEDROCK_AWS_ACCESS_KEY_ID = '';
      process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = '';
      const params = createMockParams();
      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig.credentials).toBeUndefined();
    });

    it('should set credentials to undefined when access key and secret are undefined', async () => {
      delete process.env.BEDROCK_AWS_ACCESS_KEY_ID;
      delete process.env.BEDROCK_AWS_SECRET_ACCESS_KEY;
      const params = createMockParams();
      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig.credentials).toBeUndefined();
    });

    it('should throw when only one static credential value is set', async () => {
      delete process.env.BEDROCK_AWS_SECRET_ACCESS_KEY;
      const params = createMockParams();

      await expect(initializeBedrock(params)).rejects.toThrow(
        'Both BEDROCK_AWS_ACCESS_KEY_ID and BEDROCK_AWS_SECRET_ACCESS_KEY must be provided together.',
      );
    });

    it('should throw error when user-provided credentials are not found', async () => {
      process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = AuthType.USER_PROVIDED;
      const params = createMockParams();
      (params.db.getUserKey as jest.Mock).mockResolvedValue(null);

      await expect(initializeBedrock(params)).rejects.toThrow(
        'Bedrock credentials not provided. Please provide them again.',
      );
    });
  });

  describe('Return Structure', () => {
    it('should return llmConfig and configOptions', async () => {
      const params = createMockParams();
      const result = await initializeBedrock(params);

      expect(result).toHaveProperty('llmConfig');
      expect(result).toHaveProperty('configOptions');
      expect(typeof result.configOptions).toBe('object');
    });
  });

  describe('Inference Profile Configuration', () => {
    it('should set applicationInferenceProfile when model has matching inference profile config', async () => {
      const inferenceProfileArn =
        'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123';

      const params = createMockParams({
        config: {
          endpoints: {
            [EModelEndpoint.bedrock]: {
              inferenceProfiles: {
                'us.anthropic.claude-3-7-sonnet-20250219-v1:0': inferenceProfileArn,
              },
            },
          },
        },
        model_parameters: {
          model: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig).toHaveProperty('applicationInferenceProfile', inferenceProfileArn);
    });

    it('should NOT set applicationInferenceProfile when model has no matching config', async () => {
      const params = createMockParams({
        config: {
          endpoints: {
            [EModelEndpoint.bedrock]: {
              inferenceProfiles: {
                'us.anthropic.claude-sonnet-4-5-20250929-v1:0':
                  'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/xyz789',
              },
            },
          },
        },
        model_parameters: {
          model: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0', // Different model
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig).not.toHaveProperty('applicationInferenceProfile');
    });

    it('should resolve environment variable in inference profile ARN', async () => {
      const inferenceProfileArn =
        'arn:aws:bedrock:us-east-1:951834775723:application-inference-profile/yjr1elcyt29s';
      process.env.BEDROCK_INFERENCE_PROFILE_ARN = inferenceProfileArn;

      const params = createMockParams({
        config: {
          endpoints: {
            [EModelEndpoint.bedrock]: {
              inferenceProfiles: {
                'us.anthropic.claude-3-7-sonnet-20250219-v1:0': '${BEDROCK_INFERENCE_PROFILE_ARN}',
              },
            },
          },
        },
        model_parameters: {
          model: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig).toHaveProperty('applicationInferenceProfile', inferenceProfileArn);
    });

    it('should use direct ARN when no env variable syntax is used', async () => {
      const directArn =
        'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/direct123';

      const params = createMockParams({
        config: {
          endpoints: {
            [EModelEndpoint.bedrock]: {
              inferenceProfiles: {
                'us.anthropic.claude-3-7-sonnet-20250219-v1:0': directArn,
              },
            },
          },
        },
        model_parameters: {
          model: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig).toHaveProperty('applicationInferenceProfile', directArn);
    });

    it('should fall back to original string when env variable is not set', async () => {
      // Ensure the env var is not set
      delete process.env.NONEXISTENT_PROFILE_ARN;

      const params = createMockParams({
        config: {
          endpoints: {
            [EModelEndpoint.bedrock]: {
              inferenceProfiles: {
                'us.anthropic.claude-3-7-sonnet-20250219-v1:0': '${NONEXISTENT_PROFILE_ARN}',
              },
            },
          },
        },
        model_parameters: {
          model: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      // Should return the original ${VAR} string when env var doesn't exist
      expect(result.llmConfig).toHaveProperty(
        'applicationInferenceProfile',
        '${NONEXISTENT_PROFILE_ARN}',
      );
    });

    it('should resolve multiple different env variables for different models', async () => {
      const claude37Arn =
        'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/claude37';
      const sonnet45Arn =
        'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/sonnet45';

      process.env.CLAUDE_37_PROFILE = claude37Arn;
      process.env.SONNET_45_PROFILE = sonnet45Arn;

      const params = createMockParams({
        config: {
          endpoints: {
            [EModelEndpoint.bedrock]: {
              inferenceProfiles: {
                'us.anthropic.claude-3-7-sonnet-20250219-v1:0': '${CLAUDE_37_PROFILE}',
                'us.anthropic.claude-sonnet-4-5-20250929-v1:0': '${SONNET_45_PROFILE}',
              },
            },
          },
        },
        model_parameters: {
          model: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig).toHaveProperty('applicationInferenceProfile', claude37Arn);
    });

    it('should handle env variable with whitespace around it', async () => {
      const inferenceProfileArn =
        'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/trimmed';
      process.env.TRIMMED_PROFILE_ARN = inferenceProfileArn;

      const params = createMockParams({
        config: {
          endpoints: {
            [EModelEndpoint.bedrock]: {
              inferenceProfiles: {
                'us.anthropic.claude-3-7-sonnet-20250219-v1:0': '  ${TRIMMED_PROFILE_ARN}  ',
              },
            },
          },
        },
        model_parameters: {
          model: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig).toHaveProperty('applicationInferenceProfile', inferenceProfileArn);
    });

    it('should NOT set applicationInferenceProfile when inferenceProfiles config is empty', async () => {
      const params = createMockParams({
        config: {
          endpoints: {
            [EModelEndpoint.bedrock]: {
              inferenceProfiles: {},
            },
          },
        },
        model_parameters: {
          model: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig).not.toHaveProperty('applicationInferenceProfile');
    });

    it('should NOT set applicationInferenceProfile when no bedrock config exists', async () => {
      const params = createMockParams({
        config: {},
        model_parameters: {
          model: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig).not.toHaveProperty('applicationInferenceProfile');
    });

    it('should handle multiple inference profiles and select the correct one', async () => {
      const sonnet45Arn =
        'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/sonnet45';
      const claude37Arn =
        'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/claude37';

      const params = createMockParams({
        config: {
          endpoints: {
            [EModelEndpoint.bedrock]: {
              inferenceProfiles: {
                'us.anthropic.claude-sonnet-4-5-20250929-v1:0': sonnet45Arn,
                'us.anthropic.claude-3-7-sonnet-20250219-v1:0': claude37Arn,
                'global.anthropic.claude-opus-4-5-20251101-v1:0':
                  'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/opus45',
              },
            },
          },
        },
        model_parameters: {
          model: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig).toHaveProperty('applicationInferenceProfile', claude37Arn);
    });

    it('should work alongside guardrailConfig', async () => {
      const inferenceProfileArn =
        'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123';
      const guardrailConfig = {
        guardrailIdentifier: 'test-guardrail',
        guardrailVersion: '1',
      };

      const params = createMockParams({
        config: {
          endpoints: {
            [EModelEndpoint.bedrock]: {
              inferenceProfiles: {
                'us.anthropic.claude-3-7-sonnet-20250219-v1:0': inferenceProfileArn,
              },
              guardrailConfig,
            },
          },
        },
        model_parameters: {
          model: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig).toHaveProperty('applicationInferenceProfile', inferenceProfileArn);
      expect(result.llmConfig).toHaveProperty('guardrailConfig', guardrailConfig);
    });

    it('should preserve the original model ID in llmConfig.model', async () => {
      const inferenceProfileArn =
        'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123';

      const params = createMockParams({
        config: {
          endpoints: {
            [EModelEndpoint.bedrock]: {
              inferenceProfiles: {
                'us.anthropic.claude-3-7-sonnet-20250219-v1:0': inferenceProfileArn,
              },
            },
          },
        },
        model_parameters: {
          model: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      // Model ID should remain unchanged - only applicationInferenceProfile should be set
      expect(result.llmConfig).toHaveProperty(
        'model',
        'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
      );
      expect(result.llmConfig).toHaveProperty('applicationInferenceProfile', inferenceProfileArn);
    });
  });

  describe('Opus 4.6 Adaptive Thinking', () => {
    it('should default adaptive maxTokens to the model max output for Opus 4.6', async () => {
      const params = createMockParams({
        model_parameters: {
          model: 'anthropic.claude-opus-4-6-v1',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;
      const amrf = result.llmConfig.additionalModelRequestFields as Record<string, unknown>;

      expect(amrf.thinking).toEqual({ type: 'adaptive' });
      expect(result.llmConfig.maxTokens).toBe(128000);
      expect(amrf.anthropic_beta).toEqual(expect.arrayContaining(BEDROCK_CLAUDE_4_BETAS));
    });

    it('should pass effort via output_config for Opus 4.6', async () => {
      const params = createMockParams({
        model_parameters: {
          model: 'anthropic.claude-opus-4-6-v1',
          effort: 'medium',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;
      const amrf = result.llmConfig.additionalModelRequestFields as Record<string, unknown>;

      expect(amrf.thinking).toEqual({ type: 'adaptive' });
      expect(amrf.output_config).toEqual({ effort: 'medium' });
    });

    it('should preserve user-provided anthropic beta values for Opus 4.6', async () => {
      const params = createMockParams({
        model_parameters: {
          model: 'anthropic.claude-opus-4-6-v1',
          additionalModelRequestFields: {
            anthropic_beta: ['context-1m-2025-08-07'],
          },
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;
      const amrf = result.llmConfig.additionalModelRequestFields as Record<string, unknown>;

      expect(amrf.anthropic_beta).toEqual(['context-1m-2025-08-07', ...BEDROCK_CLAUDE_4_BETAS]);
    });

    it('should respect user-provided maxTokens for Opus 4.6', async () => {
      const params = createMockParams({
        model_parameters: {
          model: 'anthropic.claude-opus-4-6-v1',
          maxTokens: 32000,
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig.maxTokens).toBe(32000);
    });

    it('should handle cross-region Opus 4.6 model IDs', async () => {
      const params = createMockParams({
        model_parameters: {
          model: 'us.anthropic.claude-opus-4-6-v1',
          effort: 'low',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;
      const amrf = result.llmConfig.additionalModelRequestFields as Record<string, unknown>;

      expect(result.llmConfig).toHaveProperty('model', 'us.anthropic.claude-opus-4-6-v1');
      expect(amrf.thinking).toEqual({ type: 'adaptive' });
      expect(amrf.output_config).toEqual({ effort: 'low' });
    });

    it('should use enabled thinking for non-adaptive models (Sonnet 4.5)', async () => {
      const params = createMockParams({
        model_parameters: {
          model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;
      const amrf = result.llmConfig.additionalModelRequestFields as Record<string, unknown>;

      expect(amrf.thinking).toEqual({ type: 'enabled', budget_tokens: 2000 });
      expect(amrf.output_config).toBeUndefined();
      expect(result.llmConfig.maxTokens).toBe(64000);
    });

    it('should not include output_config when effort is empty', async () => {
      const params = createMockParams({
        model_parameters: {
          model: 'anthropic.claude-opus-4-6-v1',
          effort: '',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;
      const amrf = result.llmConfig.additionalModelRequestFields as Record<string, unknown>;

      expect(amrf.thinking).toEqual({ type: 'adaptive' });
      expect(amrf.output_config).toBeUndefined();
    });

    it('should strip effort for non-adaptive models', async () => {
      const params = createMockParams({
        model_parameters: {
          model: 'anthropic.claude-opus-4-1-20250805-v1:0',
          effort: 'high',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;
      const amrf = result.llmConfig.additionalModelRequestFields as Record<string, unknown>;

      expect(amrf.thinking).toEqual({ type: 'enabled', budget_tokens: 2000 });
      expect(amrf.output_config).toBeUndefined();
      expect(amrf.effort).toBeUndefined();
    });
  });

  describe('Bedrock reasoning_effort for Moonshot/ZAI models', () => {
    it('should map reasoning_effort to reasoning_config for Moonshot Kimi K2.5', async () => {
      const params = createMockParams({
        model_parameters: {
          model: 'moonshotai.kimi-k2.5',
          reasoning_effort: 'high',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;
      const amrf = result.llmConfig.additionalModelRequestFields as Record<string, unknown>;

      expect(amrf.reasoning_config).toBe('high');
      expect(amrf.reasoning_effort).toBeUndefined();
      expect(amrf.thinking).toBeUndefined();
      expect(amrf.anthropic_beta).toBeUndefined();
    });

    it('should map reasoning_effort to reasoning_config for ZAI GLM', async () => {
      const params = createMockParams({
        model_parameters: {
          model: 'zai.glm-4.7',
          reasoning_effort: 'medium',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;
      const amrf = result.llmConfig.additionalModelRequestFields as Record<string, unknown>;

      expect(amrf.reasoning_config).toBe('medium');
      expect(amrf.reasoning_effort).toBeUndefined();
    });

    it('should not include reasoning_config when reasoning_effort is unset', async () => {
      const params = createMockParams({
        model_parameters: {
          model: 'moonshotai.kimi-k2.5',
          reasoning_effort: '',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;

      expect(result.llmConfig.additionalModelRequestFields).toBeUndefined();
    });

    it('should not map reasoning_effort to reasoning_config for Anthropic models', async () => {
      const params = createMockParams({
        model_parameters: {
          model: 'anthropic.claude-opus-4-6-v1',
          reasoning_effort: 'high',
        },
      });

      const result = (await initializeBedrock(params)) as BedrockLLMConfigResult;
      const amrf = result.llmConfig.additionalModelRequestFields as Record<string, unknown>;

      expect(amrf.reasoning_config).toBeUndefined();
      expect(amrf.thinking).toEqual({ type: 'adaptive' });
    });
  });
});

describe('initializeBedrock streamRate resolution', () => {
  beforeEach(() => {
    process.env.BEDROCK_AWS_ACCESS_KEY_ID = 'test-access-key';
    process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = 'test-secret-key';
    process.env.BEDROCK_AWS_DEFAULT_REGION = 'us-east-1';
  });

  async function delayFor(config: Record<string, unknown>): Promise<unknown> {
    const result = await initializeBedrock(createMockParams({ config }));
    return (result.llmConfig as Record<string, unknown>)._lc_stream_delay;
  }

  it('wires `endpoints.bedrock.streamRate` into llmConfig._lc_stream_delay', async () => {
    await expect(
      delayFor({ endpoints: { [EModelEndpoint.bedrock]: { streamRate: 25 } } }),
    ).resolves.toBe(25);
  });

  it('preserves the endpoint streamRate when `endpoints.all` exists without one', async () => {
    await expect(
      delayFor({
        endpoints: { [EModelEndpoint.bedrock]: { streamRate: 25 }, all: { activityLabel: true } },
      }),
    ).resolves.toBe(25);
  });

  it('lets `endpoints.all.streamRate` (including 0) override the endpoint value', async () => {
    await expect(
      delayFor({
        endpoints: { [EModelEndpoint.bedrock]: { streamRate: 25 }, all: { streamRate: 0 } },
      }),
    ).resolves.toBe(0);
  });

  it('leaves the delay unset when neither level configures a streamRate', async () => {
    await expect(
      delayFor({ endpoints: { all: { activityLabel: true } } }),
    ).resolves.toBeUndefined();
  });
});

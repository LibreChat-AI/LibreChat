const { fetchModels } = require('@librechat/api');
const loadConfigModels = require('./loadConfigModels');
const { getAppConfig } = require('./app');

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  fetchModels: jest.fn(),
}));
jest.mock('./app');
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
jest.mock('~/models', () => ({
  getUserKeyValues: jest.fn(),
  initializeMessageBudget: jest.fn(),
}));

const exampleConfig = {
  endpoints: {
    custom: [
      {
        name: 'Mistral',
        apiKey: '${MY_PRECIOUS_MISTRAL_KEY}',
        baseURL: 'https://api.mistral.ai/v1',
        models: {
          default: ['mistral-tiny', 'mistral-small', 'mistral-medium', 'mistral-large-latest'],
          fetch: true,
        },
        dropParams: ['stop', 'user', 'frequency_penalty', 'presence_penalty'],
      },
      {
        name: 'OpenRouter',
        apiKey: '${MY_OPENROUTER_API_KEY}',
        baseURL: 'https://openrouter.ai/api/v1',
        models: {
          default: ['gpt-3.5-turbo'],
          fetch: true,
        },
        dropParams: ['stop'],
      },
      {
        name: 'groq',
        apiKey: 'user_provided',
        baseURL: 'https://api.groq.com/openai/v1/',
        models: {
          default: ['llama2-70b-4096', 'mixtral-8x7b-32768'],
          fetch: false,
        },
      },
      {
        name: 'Ollama',
        apiKey: 'user_provided',
        baseURL: 'http://localhost:11434/v1/',
        models: {
          default: ['mistral', 'llama2:13b'],
          fetch: false,
        },
      },
      {
        name: 'MLX',
        apiKey: 'user_provided',
        baseURL: 'http://localhost:8080/v1/',
        models: {
          default: ['Meta-Llama-3-8B-Instruct-4bit'],
          fetch: false,
        },
      },
    ],
  },
};

describe('loadConfigModels', () => {
  const mockRequest = { user: { id: 'testUserId' } };

  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchModels.mockReset();
    require('~/models').getUserKeyValues.mockReset();
    process.env = { ...originalEnv };

    getAppConfig.mockResolvedValue({});
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return an empty object if customConfig is null', async () => {
    getAppConfig.mockResolvedValue(null);
    const result = await loadConfigModels(mockRequest);
    expect(result).toEqual({});
  });

  it('passes userId when resolving scoped model config', async () => {
    getAppConfig.mockResolvedValue({});

    await loadConfigModels({
      user: { id: 'testUserId', role: 'USER', tenantId: 'tenant-a' },
    });

    expect(getAppConfig).toHaveBeenCalledWith({
      role: 'USER',
      userId: 'testUserId',
      tenantId: 'tenant-a',
      idOnTheSource: undefined,
    });
  });

  it('uses req.config when available instead of calling getAppConfig', async () => {
    const result = await loadConfigModels({
      user: { id: 'testUserId' },
      config: {
        endpoints: {
          custom: [
            {
              name: 'LocalOnly',
              apiKey: 'local-key',
              baseURL: 'https://example.com/v1',
              models: { default: ['local-model'], fetch: false },
            },
          ],
        },
      },
    });

    expect(getAppConfig).not.toHaveBeenCalled();
    expect(result.LocalOnly).toEqual(['local-model']);
  });

  it('handles azure models and endpoint correctly', async () => {
    getAppConfig.mockResolvedValue({
      endpoints: {
        azureOpenAI: { modelNames: ['model1', 'model2'] },
      },
    });

    const result = await loadConfigModels(mockRequest);
    expect(result.azureOpenAI).toEqual(['model1', 'model2']);
  });

  it('fetches custom models based on the unique key', async () => {
    process.env.BASE_URL = 'http://example.com';
    process.env.API_KEY = 'some-api-key';
    const customEndpoints = [
      {
        baseURL: '${BASE_URL}',
        apiKey: '${API_KEY}',
        name: 'CustomModel',
        models: { fetch: true },
      },
    ];

    getAppConfig.mockResolvedValue({ endpoints: { custom: customEndpoints } });
    fetchModels.mockResolvedValue(['customModel1', 'customModel2']);

    const result = await loadConfigModels(mockRequest);
    expect(fetchModels).toHaveBeenCalled();
    expect(result.CustomModel).toEqual(['customModel1', 'customModel2']);
  });

  it('correctly associates models to names using unique keys', async () => {
    getAppConfig.mockResolvedValue({
      endpoints: {
        custom: [
          {
            baseURL: 'http://example.com',
            apiKey: 'API_KEY1',
            name: 'Model1',
            models: { fetch: true },
          },
          {
            baseURL: 'http://example.com',
            apiKey: 'API_KEY2',
            name: 'Model2',
            models: { fetch: true },
          },
        ],
      },
    });
    fetchModels.mockImplementation(({ apiKey }) =>
      Promise.resolve(apiKey === 'API_KEY1' ? ['model1Data'] : ['model2Data']),
    );

    const result = await loadConfigModels(mockRequest);
    expect(result.Model1).toEqual(['model1Data']);
    expect(result.Model2).toEqual(['model2Data']);
  });

  it('correctly handles multiple endpoints with the same baseURL but different apiKeys', async () => {
    // Mock the custom configuration to simulate the user's scenario
    getAppConfig.mockResolvedValue({
      endpoints: {
        custom: [
          {
            name: 'LiteLLM',
            apiKey: '${LITELLM_ALL_MODELS}',
            baseURL: '${LITELLM_HOST}',
            models: { fetch: true },
          },
          {
            name: 'OpenAI',
            apiKey: '${LITELLM_OPENAI_MODELS}',
            baseURL: '${LITELLM_SECOND_HOST}',
            models: { fetch: true },
          },
          {
            name: 'Google',
            apiKey: '${LITELLM_GOOGLE_MODELS}',
            baseURL: '${LITELLM_SECOND_HOST}',
            models: { fetch: true },
          },
        ],
      },
    });

    // Mock `fetchModels` to return different models based on the apiKey
    fetchModels.mockImplementation(({ apiKey }) => {
      switch (apiKey) {
        case '${LITELLM_ALL_MODELS}':
          return Promise.resolve(['AllModel1', 'AllModel2']);
        case '${LITELLM_OPENAI_MODELS}':
          return Promise.resolve(['OpenAIModel']);
        case '${LITELLM_GOOGLE_MODELS}':
          return Promise.resolve(['GoogleModel']);
        default:
          return Promise.resolve([]);
      }
    });

    const result = await loadConfigModels(mockRequest);

    // Assert that the models are correctly fetched and mapped based on unique keys
    expect(result.LiteLLM).toEqual(['AllModel1', 'AllModel2']);
    expect(result.OpenAI).toEqual(['OpenAIModel']);
    expect(result.Google).toEqual(['GoogleModel']);

    // Ensure that fetchModels was called with correct parameters
    expect(fetchModels).toHaveBeenCalledTimes(3);
    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: '${LITELLM_ALL_MODELS}' }),
    );
    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: '${LITELLM_OPENAI_MODELS}' }),
    );
    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: '${LITELLM_GOOGLE_MODELS}' }),
    );
  });

  it('loads models based on custom endpoint configuration respecting fetch rules', async () => {
    process.env.MY_PRECIOUS_MISTRAL_KEY = 'actual_mistral_api_key';
    process.env.MY_OPENROUTER_API_KEY = 'actual_openrouter_api_key';
    // Setup custom configuration with specific API keys for Mistral and OpenRouter
    // and "user_provided" for groq and Ollama, indicating no fetch for the latter two
    getAppConfig.mockResolvedValue(exampleConfig);

    // Assuming fetchModels would be called only for Mistral and OpenRouter
    fetchModels.mockImplementation(({ name }) => {
      switch (name) {
        case 'Mistral':
          return Promise.resolve([
            'mistral-tiny',
            'mistral-small',
            'mistral-medium',
            'mistral-large-latest',
          ]);
        case 'OpenRouter':
          return Promise.resolve(['gpt-3.5-turbo']);
        default:
          return Promise.resolve([]);
      }
    });

    const result = await loadConfigModels(mockRequest);

    // Since fetch is true and apiKey is not "user_provided", fetching occurs for Mistral and OpenRouter
    expect(result.Mistral).toEqual([
      'mistral-tiny',
      'mistral-small',
      'mistral-medium',
      'mistral-large-latest',
    ]);
    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Mistral',
        apiKey: process.env.MY_PRECIOUS_MISTRAL_KEY,
      }),
    );

    expect(result.OpenRouter).toEqual(['gpt-3.5-turbo']);
    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'OpenRouter',
        apiKey: process.env.MY_OPENROUTER_API_KEY,
      }),
    );

    // For groq and ollama, since the apiKey is "user_provided", models should not be fetched
    // Depending on your implementation's behavior regarding "default" models without fetching,
    // you may need to adjust the following assertions:
    expect(result.groq).toEqual(exampleConfig.endpoints.custom[2].models.default);
    expect(result.ollama).toEqual(exampleConfig.endpoints.custom[3].models.default);

    // Verifying fetchModels was not called for groq and ollama
    expect(fetchModels).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'groq',
      }),
    );
    expect(fetchModels).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'ollama',
      }),
    );
  });

  it('falls back to default models if fetching returns an empty array', async () => {
    getAppConfig.mockResolvedValue({
      endpoints: {
        custom: [
          {
            name: 'EndpointWithSameFetchKey',
            apiKey: 'API_KEY',
            baseURL: 'http://example.com',
            models: {
              fetch: true,
              default: ['defaultModel1'],
            },
          },
          {
            name: 'EmptyFetchModel',
            apiKey: 'API_KEY',
            baseURL: 'http://example.com',
            models: {
              fetch: true,
              default: ['defaultModel1', 'defaultModel2'],
            },
          },
        ],
      },
    });

    fetchModels.mockResolvedValue([]);

    const result = await loadConfigModels(mockRequest);
    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(result.EmptyFetchModel).toEqual(['defaultModel1', 'defaultModel2']);
  });

  it('falls back to default models if fetching returns a falsy value', async () => {
    getAppConfig.mockResolvedValue({
      endpoints: {
        custom: [
          {
            name: 'FalsyFetchModel',
            apiKey: 'API_KEY',
            baseURL: 'http://example.com',
            models: {
              fetch: true,
              default: ['defaultModel1', 'defaultModel2'],
            },
          },
        ],
      },
    });

    fetchModels.mockResolvedValue(false);

    const result = await loadConfigModels(mockRequest);

    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'FalsyFetchModel',
        apiKey: 'API_KEY',
      }),
    );

    expect(result.FalsyFetchModel).toEqual(['defaultModel1', 'defaultModel2']);
  });

  describe('user-provided API key model fetching', () => {
    it('fetches models using user-provided API key when key is stored', async () => {
      const { getUserKeyValues } = require('~/models');
      getUserKeyValues.mockResolvedValueOnce({
        apiKey: 'sk-user-key',
        baseURL: 'https://api.x.com/v1',
      });
      getAppConfig.mockResolvedValue({
        endpoints: {
          custom: [
            {
              name: 'UserEndpoint',
              apiKey: 'user_provided',
              baseURL: 'user_provided',
              models: { fetch: true, default: ['fallback-model'] },
            },
          ],
        },
      });
      fetchModels.mockResolvedValue(['fetched-model-a', 'fetched-model-b']);

      const result = await loadConfigModels(mockRequest);

      expect(getUserKeyValues).toHaveBeenCalledWith({ userId: 'testUserId', name: 'UserEndpoint' });
      expect(fetchModels).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'sk-user-key',
          baseURL: 'https://api.x.com/v1',
          skipCache: true,
        }),
      );
      expect(result.UserEndpoint).toEqual(['fetched-model-a', 'fetched-model-b']);
    });

    it('falls back to defaults when getUserKeyValues returns no apiKey', async () => {
      const { getUserKeyValues } = require('~/models');
      getUserKeyValues.mockResolvedValueOnce({ baseURL: 'https://api.x.com/v1' });
      getAppConfig.mockResolvedValue({
        endpoints: {
          custom: [
            {
              name: 'NoKeyEndpoint',
              apiKey: 'user_provided',
              baseURL: 'https://api.x.com/v1',
              models: { fetch: true, default: ['default-model'] },
            },
          ],
        },
      });

      const result = await loadConfigModels(mockRequest);

      expect(fetchModels).not.toHaveBeenCalled();
      expect(result.NoKeyEndpoint).toEqual(['default-model']);
    });

    it('falls back to defaults and logs warn when getUserKeyValues throws infra error', async () => {
      const { getUserKeyValues } = require('~/models');
      const { logger } = require('@librechat/data-schemas');
      getUserKeyValues.mockRejectedValueOnce(new Error('DB connection timeout'));
      getAppConfig.mockResolvedValue({
        endpoints: {
          custom: [
            {
              name: 'ErrorEndpoint',
              apiKey: 'user_provided',
              baseURL: 'https://api.example.com/v1',
              models: { fetch: true, default: ['fallback'] },
            },
          ],
        },
      });

      const result = await loadConfigModels(mockRequest);

      expect(fetchModels).not.toHaveBeenCalled();
      expect(result.ErrorEndpoint).toEqual(['fallback']);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Failed to retrieve user key for "ErrorEndpoint": DB connection timeout',
        ),
      );
      expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining('No user key stored'));
    });

    it('logs debug (not warn) for NO_USER_KEY errors', async () => {
      const { getUserKeyValues } = require('~/models');
      const { logger } = require('@librechat/data-schemas');
      getUserKeyValues.mockRejectedValueOnce(new Error(JSON.stringify({ type: 'no_user_key' })));
      getAppConfig.mockResolvedValue({
        endpoints: {
          custom: [
            {
              name: 'MissingKeyEndpoint',
              apiKey: 'user_provided',
              baseURL: 'https://api.example.com/v1',
              models: { fetch: true, default: ['default-model'] },
            },
          ],
        },
      });

      const result = await loadConfigModels(mockRequest);

      expect(result.MissingKeyEndpoint).toEqual(['default-model']);
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('No user key stored'));
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Failed to retrieve user key'),
      );
    });

    it('skips user key lookup when req.user.id is undefined', async () => {
      const { getUserKeyValues } = require('~/models');
      getAppConfig.mockResolvedValue({
        endpoints: {
          custom: [
            {
              name: 'NoUserEndpoint',
              apiKey: 'user_provided',
              baseURL: 'https://api.x.com/v1',
              models: { fetch: true, default: ['anon-model'] },
            },
          ],
        },
      });

      const result = await loadConfigModels({ user: {} });

      expect(getUserKeyValues).not.toHaveBeenCalled();
      expect(result.NoUserEndpoint).toEqual(['anon-model']);
    });

    it('uses stored baseURL only when baseURL is user_provided', async () => {
      const { getUserKeyValues } = require('~/models');
      getUserKeyValues.mockResolvedValueOnce({ apiKey: 'sk-key' });
      getAppConfig.mockResolvedValue({
        endpoints: {
          custom: [
            {
              name: 'KeyOnly',
              apiKey: 'user_provided',
              baseURL: 'https://fixed-base.com/v1',
              models: { fetch: true, default: ['default'] },
            },
          ],
        },
      });
      fetchModels.mockResolvedValue(['model-from-fixed-base']);

      const result = await loadConfigModels(mockRequest);

      expect(fetchModels).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'sk-key',
          baseURL: 'https://fixed-base.com/v1',
          skipCache: true,
        }),
      );
      expect(result.KeyOnly).toEqual(['model-from-fixed-base']);
    });
  });

  it('normalizes Ollama endpoint name to lowercase', async () => {
    const testCases = [
      {
        name: 'Ollama',
        apiKey: 'user_provided',
        baseURL: 'http://localhost:11434/v1/',
        models: {
          default: ['mistral', 'llama2'],
          fetch: false,
        },
      },
      {
        name: 'OLLAMA',
        apiKey: 'user_provided',
        baseURL: 'http://localhost:11434/v1/',
        models: {
          default: ['mixtral', 'codellama'],
          fetch: false,
        },
      },
      {
        name: 'OLLaMA',
        apiKey: 'user_provided',
        baseURL: 'http://localhost:11434/v1/',
        models: {
          default: ['phi', 'neural-chat'],
          fetch: false,
        },
      },
    ];

    getAppConfig.mockResolvedValue({
      endpoints: {
        custom: testCases,
      },
    });

    const result = await loadConfigModels(mockRequest);

    // All variations of "Ollama" should be normalized to lowercase "ollama"
    // and the last config in the array should override previous ones
    expect(result.Ollama).toBeUndefined();
    expect(result.OLLAMA).toBeUndefined();
    expect(result.OLLaMA).toBeUndefined();
    expect(result.ollama).toEqual(['phi', 'neural-chat']);

    // Verify fetchModels was not called since these are user_provided
    expect(fetchModels).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Ollama',
      }),
    );
    expect(fetchModels).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'OLLAMA',
      }),
    );
    expect(fetchModels).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'OLLaMA',
      }),
    );
  });
});

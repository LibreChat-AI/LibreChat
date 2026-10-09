import axios from 'axios';
import { Time, EModelEndpoint, defaultModels, AuthType } from 'librechat-data-provider';
import {
  fetchModels,
  splitAndTrim,
  getOpenAIModels,
  getGoogleModels,
  getBedrockModels,
  getAnthropicModels,
} from './models';
import { SCOPED_TOKEN_CONFIG_KEY_PREFIX } from './keys';

jest.mock('axios');

const mockValidateEndpointURL = jest.fn().mockResolvedValue(undefined);
const mockHttpAgent = { type: 'ssrf-http-agent' };
const mockHttpsAgent = { type: 'ssrf-https-agent' };
const mockCreateSSRFSafeAgents = jest.fn((_allowedAddresses?: string[] | null) => ({
  httpAgent: mockHttpAgent,
  httpsAgent: mockHttpsAgent,
}));
jest.mock('~/auth', () => ({
  validateEndpointURL: (
    ...args: [url: string, endpoint: string, allowedAddresses?: string[] | null]
  ) => mockValidateEndpointURL(...args),
  createSSRFSafeAgents: (...args: [allowedAddresses?: string[] | null]) =>
    mockCreateSSRFSafeAgents(...args),
}));

const mockCacheGet = jest.fn().mockResolvedValue(undefined);
const mockCacheSet = jest.fn().mockResolvedValue(true);
const mockTokenConfigGet = jest.fn().mockResolvedValue(undefined);
const mockTokenConfigSet = jest.fn().mockResolvedValue(true);
jest.mock('~/cache', () => ({
  standardCache: jest.fn().mockImplementation(() => ({
    get: mockCacheGet,
    set: mockCacheSet,
  })),
  tokenConfigCache: jest.fn().mockImplementation(() => ({
    get: mockTokenConfigGet,
    set: mockTokenConfigSet,
  })),
}));

jest.mock('~/utils', () => {
  const originalUtils = jest.requireActual('~/utils');
  return {
    ...originalUtils,
    processModelData: jest.fn((...args) => originalUtils.processModelData(...args)),
    logAxiosError: jest.fn(),
    resolveHeaders: jest.fn((options) => options?.headers || {}),
  };
});

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const { logAxiosError, resolveHeaders } = jest.requireMock('~/utils');

mockedAxios.get.mockResolvedValue({
  data: {
    data: [{ id: 'model-1' }, { id: 'model-2' }],
  },
});

beforeEach(() => {
  mockCacheGet.mockReset().mockResolvedValue(undefined);
  mockCacheSet.mockReset().mockResolvedValue(true);
  mockTokenConfigGet.mockReset().mockResolvedValue(undefined);
  mockTokenConfigSet.mockReset().mockResolvedValue(true);
  mockValidateEndpointURL.mockReset().mockResolvedValue(undefined);
  mockCreateSSRFSafeAgents.mockClear();
});

describe('fetchModels', () => {
  it('fetches models successfully from the API', async () => {
    const models = await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
    });

    expect(models).toEqual(['model-1', 'model-2']);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.test.com/models'),
      expect.any(Object),
    );
  });

  it('adds the user ID to the models query when option and ID are passed', async () => {
    const models = await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      userIdQuery: true,
      name: 'TestAPI',
    });

    expect(models).toEqual(['model-1', 'model-2']);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.test.com/models?user=user123'),
      expect.any(Object),
    );
  });

  it('should pass custom headers to the API request', async () => {
    const customHeaders = {
      'X-Custom-Header': 'custom-value',
      'X-API-Version': 'v2',
    };

    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
      headers: customHeaders,
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.test.com/models'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Custom-Header': 'custom-value',
          'X-API-Version': 'v2',
          Authorization: 'Bearer testApiKey',
        }),
      }),
    );
  });

  it('should handle null headers gracefully', async () => {
    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
      headers: null,
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.test.com/models'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer testApiKey',
        }),
      }),
    );
  });

  it('should handle undefined headers gracefully', async () => {
    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
      headers: undefined,
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.test.com/models'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer testApiKey',
        }),
      }),
    );
  });

  it('should resolve template variables in custom headers on the OpenAI-compatible path', async () => {
    const customHeaders = {
      Authorization: 'Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}',
      'X-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
    };
    const userObject = { id: 'user123', email: 'user@example.com' };

    (resolveHeaders as jest.Mock).mockReturnValueOnce({
      Authorization: 'Bearer resolved-jwt',
      'X-User-Email': 'user@example.com',
    });

    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
      headers: customHeaders,
      userObject,
    });

    expect(resolveHeaders).toHaveBeenCalledWith({
      headers: customHeaders,
      user: userObject,
      stripUnresolved: true,
    });
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.test.com/models'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer resolved-jwt',
          'X-User-Email': 'user@example.com',
        }),
      }),
    );
  });

  it('should preserve a config-supplied Authorization header instead of overwriting with the apiKey default', async () => {
    const customHeaders = {
      Authorization: 'Bearer user-jwt-token',
    };

    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
      headers: customHeaders,
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.test.com/models'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer user-jwt-token',
        }),
      }),
    );
    expect(mockedAxios.get).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer testApiKey',
        }),
      }),
    );
  });

  it('should treat Authorization header case-insensitively when skipping the apiKey default', async () => {
    const customHeaders = {
      authorization: 'Bearer lower-case-user-jwt',
    };

    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
      headers: customHeaders,
    });

    const lastCall = mockedAxios.get.mock.calls[mockedAxios.get.mock.calls.length - 1];
    const sentHeaders = lastCall[1]?.headers ?? {};
    expect(sentHeaders.authorization).toBe('Bearer lower-case-user-jwt');
    expect(sentHeaders.Authorization).toBeUndefined();
  });

  it('validates and hardens user-provided base URL model fetches', async () => {
    const savedEnv = {
      PROXY: process.env.PROXY,
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      NO_PROXY: process.env.NO_PROXY,
    };
    delete process.env.PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.NO_PROXY;

    try {
      await fetchModels({
        user: 'user123',
        apiKey: 'testApiKey',
        baseURL: 'https://api.test.com',
        baseURLIsUserProvided: true,
        allowedAddresses: ['10.0.0.5:443'],
        name: 'TestAPI',
      });
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }

    expect(mockValidateEndpointURL).toHaveBeenCalledWith('https://api.test.com', 'TestAPI', [
      '10.0.0.5:443',
    ]);
    expect(mockCreateSSRFSafeAgents).toHaveBeenCalledWith(['10.0.0.5:443']);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.test.com/models',
      expect.objectContaining({
        httpAgent: mockHttpAgent,
        httpsAgent: mockHttpsAgent,
        maxRedirects: 0,
        proxy: false,
      }),
    );
  });

  it('rejects a blocked user-provided base URL before any model fetch request', async () => {
    mockValidateEndpointURL.mockRejectedValueOnce(new Error('blocked SSRF target'));

    await expect(
      fetchModels({
        user: 'user123',
        apiKey: 'testApiKey',
        baseURL: 'http://127.0.0.1:11434/v1',
        baseURLIsUserProvided: true,
        name: 'TestAPI',
      }),
    ).rejects.toThrow('blocked SSRF target');

    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });
});

describe('fetchModels with createTokenConfig true', () => {
  const data = {
    data: [
      {
        id: 'model-1',
        pricing: {
          prompt: '0.002',
          completion: '0.001',
        },
        context_length: 1024,
      },
      {
        id: 'model-2',
        pricing: {
          prompt: '0.003',
          completion: '0.0015',
        },
        context_length: 2048,
      },
    ],
  };

  beforeEach(() => {
    mockedAxios.get.mockClear();
    mockedAxios.get.mockResolvedValue({ data });
  });

  it('creates and stores token configuration if createTokenConfig is true', async () => {
    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      createTokenConfig: true,
    });

    const { processModelData } = jest.requireMock('~/utils');
    expect(processModelData).toHaveBeenCalled();
    expect(processModelData).toHaveBeenCalledWith(data);
  });

  it('backfills requested token config when model cache hits', async () => {
    const endpointTokenConfig = {
      'model-1': { prompt: 2000, completion: 1000, context: 1024 },
    };
    mockCacheGet.mockResolvedValue(['model-1']);
    mockTokenConfigGet.mockResolvedValue(endpointTokenConfig);

    const models = await fetchModels({
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
      tokenKey: `${SCOPED_TOKEN_CONFIG_KEY_PREFIX}tenant\u0000abc123`,
    });

    expect(models).toEqual(['model-1']);
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(
      mockTokenConfigGet.mock.calls[0][0].startsWith(`${SCOPED_TOKEN_CONFIG_KEY_PREFIX}models`),
    ).toBe(true);
    expect(mockTokenConfigSet).toHaveBeenCalledWith(
      `${SCOPED_TOKEN_CONFIG_KEY_PREFIX}tenant\u0000abc123`,
      endpointTokenConfig,
    );
  });

  it('fetches and writes token config when scoped token key is missing on model cache hit', async () => {
    mockCacheGet.mockResolvedValue(['cached-model']);
    mockTokenConfigGet.mockResolvedValue(undefined);

    const models = await fetchModels({
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
      tokenKey: `${SCOPED_TOKEN_CONFIG_KEY_PREFIX}tenant\u0000def456`,
    });

    expect(models).toEqual(['model-1', 'model-2']);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.test.com/models'),
      expect.any(Object),
    );
    expect(mockTokenConfigSet).toHaveBeenCalledWith(
      `${SCOPED_TOKEN_CONFIG_KEY_PREFIX}tenant\u0000def456`,
      expect.objectContaining({
        'model-1': expect.objectContaining({ context: 1024 }),
      }),
    );
    const sourceSetCall = mockTokenConfigSet.mock.calls.find(([key]) =>
      key.startsWith(`${SCOPED_TOKEN_CONFIG_KEY_PREFIX}models`),
    );
    expect(sourceSetCall).toBeDefined();
  });
});

describe('getOpenAIModels', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    mockedAxios.get.mockRejectedValue(new Error('Network error'));
  });

  afterEach(() => {
    process.env = originalEnv;
    mockedAxios.get.mockReset();
  });

  it('returns default models when no environment configurations are provided (and fetch fails)', async () => {
    const models = await getOpenAIModels({ user: 'user456' });
    expect(models).toContain('gpt-5.5');
  });

  it('returns default models when OpenAI API key is user provided', async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [{ id: 'should-not-appear' }] } });
    process.env.OPENAI_API_KEY = AuthType.USER_PROVIDED;

    const models = await getOpenAIModels({ user: 'user456' });

    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(models).not.toContain('should-not-appear');
    expect(models).toContain('gpt-5.5');
  });

  it('fetches models when OpenAI API key is provided through options', async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [{ id: 'gpt-runtime-key' }] } });
    process.env.OPENAI_API_KEY = AuthType.USER_PROVIDED;

    const models = await getOpenAIModels({ user: 'user456', openAIApiKey: 'sk-runtime' });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.openai.com/v1/models'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-runtime',
        }),
      }),
    );
    expect(models).toEqual(['gpt-runtime-key']);
  });

  it('falls back to environment OpenAI API key when options key is empty', async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [{ id: 'gpt-env-key' }] } });
    process.env.OPENAI_API_KEY = 'sk-env';

    const models = await getOpenAIModels({ user: 'user456', openAIApiKey: '' });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.openai.com/v1/models'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-env',
        }),
      }),
    );
    expect(models).toEqual(['gpt-env-key']);
  });

  it('forwards configured custom headers to the OpenAI model fetch', async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [{ id: 'gpt-x' }] } });
    process.env.OPENAI_API_KEY = 'sk-env';

    await getOpenAIModels({
      user: 'user456',
      headers: { 'cf-aig-token': 'tok' },
      userObject: { id: 'user456' },
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('https://api.openai.com/v1/models'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'cf-aig-token': 'tok' }),
      }),
    );
  });

  it('returns `AZURE_OPENAI_MODELS` with `azure` flag (and fetch fails)', async () => {
    process.env.AZURE_OPENAI_MODELS = 'azure-model,azure-model-2';
    const models = await getOpenAIModels({ azure: true });
    expect(models).toEqual(expect.arrayContaining(['azure-model', 'azure-model-2']));
  });

  it('returns `OPENAI_MODELS` with no flags (and fetch fails)', async () => {
    process.env.OPENAI_MODELS = 'openai-model,openai-model-2';
    const models = await getOpenAIModels({});
    expect(models).toEqual(expect.arrayContaining(['openai-model', 'openai-model-2']));
  });

  it('utilizes proxy configuration when PROXY is set', async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [],
      },
    });
    process.env.PROXY = 'http://localhost:8888';
    process.env.OPENAI_API_KEY = 'mockedApiKey';
    await getOpenAIModels({ user: 'user456' });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        httpsAgent: expect.anything(),
      }),
    );
  });
});

describe('getOpenAIModels sorting behavior', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.OPENAI_API_KEY = 'mockedApiKey';
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          { id: 'gpt-3.5-turbo-instruct-0914' },
          { id: 'gpt-3.5-turbo-instruct' },
          { id: 'gpt-3.5-turbo' },
          { id: 'gpt-4-0314' },
          { id: 'gpt-4-turbo-preview' },
        ],
      },
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  it('ensures instruct models are listed last', async () => {
    const models = await getOpenAIModels({ user: 'user456' });

    expect(models[models.length - 1]).toMatch(/instruct/);

    const instructIndexes = models
      .map((model, index) => (model.includes('instruct') ? index : -1))
      .filter((index) => index !== -1);
    const nonInstructIndexes = models
      .map((model, index) => (!model.includes('instruct') ? index : -1))
      .filter((index) => index !== -1);

    expect(Math.max(...nonInstructIndexes)).toBeLessThan(Math.min(...instructIndexes));

    const expectedOrder = [
      'gpt-3.5-turbo',
      'gpt-4-0314',
      'gpt-4-turbo-preview',
      'gpt-3.5-turbo-instruct-0914',
      'gpt-3.5-turbo-instruct',
    ];
    expect(models).toEqual(expectedOrder);
  });

  it('keeps chat-latest when filtering official OpenAI results', async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          { id: 'chat-latest' },
          { id: 'gpt-5.5' },
          { id: 'dall-e-3' },
          { id: 'gpt-realtime-2' },
        ],
      },
    });

    const models = await getOpenAIModels({ user: 'user456' });

    expect(models).toContain('chat-latest');
    expect(models).toContain('gpt-5.5');
    expect(models).not.toContain('dall-e-3');
    expect(models).not.toContain('gpt-realtime-2');
  });
});

describe('fetchModels with Ollama specific logic', () => {
  const mockOllamaData = {
    data: {
      models: [{ name: 'Ollama-Base' }, { name: 'Ollama-Advanced' }],
    },
  };

  beforeEach(() => {
    mockedAxios.get.mockResolvedValue(mockOllamaData);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should fetch Ollama models when name starts with "ollama"', async () => {
    const models = await fetchModels({
      user: 'user789',
      apiKey: 'testApiKey',
      baseURL: 'https://api.ollama.test.com',
      name: 'OllamaAPI',
    });

    expect(models).toEqual(['Ollama-Base', 'Ollama-Advanced']);
    expect(mockedAxios.get).toHaveBeenCalledWith('https://api.ollama.test.com/api/tags', {
      headers: {},
      timeout: 5000,
    });
  });

  it('should pass headers and user object to Ollama fetchModels', async () => {
    const customHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer custom-token',
    };
    const userObject = {
      id: 'user789',
      email: 'test@example.com',
    };

    (resolveHeaders as jest.Mock).mockReturnValueOnce(customHeaders);

    const models = await fetchModels({
      user: 'user789',
      apiKey: 'testApiKey',
      baseURL: 'https://api.ollama.test.com',
      name: 'ollama',
      headers: customHeaders,
      userObject,
    });

    expect(models).toEqual(['Ollama-Base', 'Ollama-Advanced']);
    expect(resolveHeaders).toHaveBeenCalledWith({
      headers: customHeaders,
      user: userObject,
      stripUnresolved: true,
    });
    expect(mockedAxios.get).toHaveBeenCalledWith('https://api.ollama.test.com/api/tags', {
      headers: customHeaders,
      timeout: 5000,
    });
  });

  it('should handle errors gracefully when fetching Ollama models fails and fallback to OpenAI-compatible fetch', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('Ollama API error'));
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        data: [{ id: 'fallback-model-1' }, { id: 'fallback-model-2' }],
      },
    });

    const models = await fetchModels({
      user: 'user789',
      apiKey: 'testApiKey',
      baseURL: 'https://api.ollama.test.com',
      name: 'OllamaAPI',
    });

    expect(models).toEqual(['fallback-model-1', 'fallback-model-2']);
    expect(logAxiosError).toHaveBeenCalledWith({
      message:
        'Failed to fetch models from Ollama API. Attempting to fetch via OpenAI-compatible endpoint.',
      error: expect.any(Error),
    });
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('should return an empty array if no baseURL is provided', async () => {
    const models = await fetchModels({
      user: 'user789',
      apiKey: 'testApiKey',
      name: 'OllamaAPI',
    });
    expect(models).toEqual([]);
  });

  it('should not fetch Ollama models if the name does not start with "ollama"', async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [{ id: 'model-1' }, { id: 'model-2' }],
      },
    });

    const models = await fetchModels({
      user: 'user789',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
    });

    expect(models).toEqual(['model-1', 'model-2']);
    expect(mockedAxios.get).toHaveBeenCalledWith('https://api.test.com/models', expect.any(Object));
  });

  it('writes Ollama models to cache with TTL', async () => {
    mockCacheGet.mockReset().mockResolvedValue(undefined);
    mockCacheSet.mockReset().mockResolvedValue(true);

    await fetchModels({
      apiKey: 'testApiKey',
      baseURL: 'https://api.ollama.test.com',
      name: 'OllamaAPI',
    });

    expect(mockCacheSet).toHaveBeenCalledWith(
      expect.any(String),
      ['Ollama-Base', 'Ollama-Advanced'],
      Time.TWO_MINUTES,
    );
  });

  it('returns Ollama models from cache without hitting server', async () => {
    mockCacheGet.mockReset().mockResolvedValue(['cached-ollama-model']);
    mockCacheSet.mockReset().mockResolvedValue(true);

    const models = await fetchModels({
      apiKey: 'testApiKey',
      baseURL: 'https://api.ollama.test.com',
      name: 'OllamaAPI',
    });

    expect(models).toEqual(['cached-ollama-model']);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});

describe('fetchModels URL construction with trailing slashes', () => {
  beforeEach(() => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [{ id: 'model-1' }, { id: 'model-2' }],
      },
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should not create double slashes when baseURL has a trailing slash', async () => {
    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com/v1/',
      name: 'TestAPI',
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.test.com/v1/models',
      expect.any(Object),
    );
  });

  it('should handle baseURL without trailing slash normally', async () => {
    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com/v1',
      name: 'TestAPI',
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.test.com/v1/models',
      expect.any(Object),
    );
  });

  it('should handle baseURL with multiple trailing slashes', async () => {
    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com/v1///',
      name: 'TestAPI',
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.test.com/v1/models',
      expect.any(Object),
    );
  });

  it('should correctly append query params after stripping trailing slashes', async () => {
    await fetchModels({
      user: 'user123',
      apiKey: 'testApiKey',
      baseURL: 'https://api.test.com/v1/',
      name: 'TestAPI',
      userIdQuery: true,
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.test.com/v1/models?user=user123',
      expect.any(Object),
    );
  });
});

describe('splitAndTrim', () => {
  it('should split a string by commas and trim each value', () => {
    const input = ' model1, model2 , model3,model4 ';
    const expected = ['model1', 'model2', 'model3', 'model4'];
    expect(splitAndTrim(input)).toEqual(expected);
  });

  it('should return an empty array for empty input', () => {
    expect(splitAndTrim('')).toEqual([]);
  });

  it('should return an empty array for null input', () => {
    expect(splitAndTrim(null)).toEqual([]);
  });

  it('should return an empty array for undefined input', () => {
    expect(splitAndTrim(undefined)).toEqual([]);
  });

  it('should filter out empty values after trimming', () => {
    const input = 'model1,,  ,model2,';
    const expected = ['model1', 'model2'];
    expect(splitAndTrim(input)).toEqual(expected);
  });
});

describe('getAnthropicModels', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  it('returns default models when ANTHROPIC_MODELS is not set', async () => {
    delete process.env.ANTHROPIC_MODELS;
    const models = await getAnthropicModels();
    expect(models).toEqual(defaultModels[EModelEndpoint.anthropic]);
  });

  it('returns models from ANTHROPIC_MODELS when set', async () => {
    process.env.ANTHROPIC_MODELS = 'claude-1, claude-2 ';
    const models = await getAnthropicModels();
    expect(models).toEqual(['claude-1', 'claude-2']);
  });

  it('should use Anthropic-specific headers when fetching models', async () => {
    delete process.env.ANTHROPIC_MODELS;
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

    mockedAxios.get.mockResolvedValue({
      data: {
        data: [{ id: 'claude-3' }, { id: 'claude-4' }],
      },
    });

    await fetchModels({
      user: 'user123',
      apiKey: 'test-anthropic-key',
      baseURL: 'https://api.anthropic.com/v1',
      name: EModelEndpoint.anthropic,
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          'x-api-key': 'test-anthropic-key',
          'anthropic-version': expect.any(String),
        },
      }),
    );
  });

  it('forwards custom headers for the Anthropic endpoint alongside managed auth', async () => {
    const customHeaders = {
      'X-Custom-Header': 'custom-value',
    };

    mockedAxios.get.mockResolvedValue({
      data: {
        data: [{ id: 'claude-3' }],
      },
    });

    await fetchModels({
      user: 'user123',
      apiKey: 'test-anthropic-key',
      baseURL: 'https://api.anthropic.com/v1',
      name: EModelEndpoint.anthropic,
      headers: customHeaders,
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          'X-Custom-Header': 'custom-value',
          'x-api-key': 'test-anthropic-key',
          'anthropic-version': expect.any(String),
        },
      }),
    );
  });

  it('threads configured headers through getAnthropicModels to the fetch', async () => {
    delete process.env.ANTHROPIC_MODELS;
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    mockedAxios.get.mockResolvedValue({ data: { data: [{ id: 'claude-3' }] } });

    await getAnthropicModels({
      user: 'user123',
      headers: { 'cf-aig-token': 'tok' },
      userObject: { id: 'user123' },
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'cf-aig-token': 'tok' }),
      }),
    );
  });
});

describe('getGoogleModels', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns default models when GOOGLE_MODELS is not set', () => {
    delete process.env.GOOGLE_MODELS;
    const models = getGoogleModels();
    expect(models).toEqual(defaultModels[EModelEndpoint.google]);
  });

  it('returns models from GOOGLE_MODELS when set', () => {
    process.env.GOOGLE_MODELS = 'gemini-pro, bard ';
    const models = getGoogleModels();
    expect(models).toEqual(['gemini-pro', 'bard']);
  });
});

describe('getBedrockModels', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns default models when BEDROCK_AWS_MODELS is not set', () => {
    delete process.env.BEDROCK_AWS_MODELS;
    const models = getBedrockModels();
    expect(models).toEqual(defaultModels[EModelEndpoint.bedrock]);
  });

  it('returns models from BEDROCK_AWS_MODELS when set', () => {
    process.env.BEDROCK_AWS_MODELS = 'anthropic.claude-v2, ai21.j2-ultra ';
    const models = getBedrockModels();
    expect(models).toEqual(['anthropic.claude-v2', 'ai21.j2-ultra']);
  });
});

describe('fetchModels caching behavior', () => {
  beforeEach(() => {
    mockCacheGet.mockReset().mockResolvedValue(undefined);
    mockCacheSet.mockReset().mockResolvedValue(true);
    mockedAxios.get.mockResolvedValue({
      data: { data: [{ id: 'cached-model-1' }, { id: 'cached-model-2' }] },
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('writes fetched models to cache with TTL', async () => {
    await fetchModels({
      apiKey: 'key',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
    });

    expect(mockCacheSet).toHaveBeenCalledWith(
      expect.any(String),
      ['cached-model-1', 'cached-model-2'],
      Time.TWO_MINUTES,
    );
  });

  it('returns cached result without making HTTP request', async () => {
    mockCacheGet.mockResolvedValue(['from-cache']);

    const models = await fetchModels({
      apiKey: 'key',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
    });

    expect(models).toEqual(['from-cache']);
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(mockCacheSet).not.toHaveBeenCalled();
  });

  it('does not read or write cache when skipCache is true', async () => {
    await fetchModels({
      apiKey: 'key',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
      skipCache: true,
    });

    expect(mockCacheGet).not.toHaveBeenCalled();
    expect(mockCacheSet).not.toHaveBeenCalled();
  });

  it('does not write to cache when fetch returns empty models', async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [] } });

    await fetchModels({
      apiKey: 'key',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
    });

    expect(mockCacheSet).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.any(Number),
    );
  });

  it('skips MODEL_QUERIES cache when both headers and userObject are supplied (user-scoped response)', async () => {
    await fetchModels({
      apiKey: 'key',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
      headers: { Authorization: 'Bearer some-user-token' },
      userObject: { id: 'user-1' },
    });

    expect(mockCacheGet).not.toHaveBeenCalled();
    expect(mockCacheSet).not.toHaveBeenCalled();
  });

  it('still uses cache when headers are supplied without a userObject (no per-user resolution)', async () => {
    await fetchModels({
      apiKey: 'key',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
      headers: { 'X-Static-Header': 'static-value' },
    });

    expect(mockCacheGet).toHaveBeenCalled();
    expect(mockCacheSet).toHaveBeenCalled();
  });

  it('still uses cache when userObject is supplied without headers', async () => {
    await fetchModels({
      apiKey: 'key',
      baseURL: 'https://api.test.com',
      name: 'TestAPI',
      userObject: { id: 'user-1' },
    });

    expect(mockCacheGet).toHaveBeenCalled();
    expect(mockCacheSet).toHaveBeenCalled();
  });
});

describe('configured model lists skip provider discovery', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.OPENAI_MODELS;
    delete process.env.ANTHROPIC_MODELS;
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockedAxios.get.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns the configured OpenAI list without requesting /models', async () => {
    const models = await getOpenAIModels({ user: 'user-1', configuredModels: ['gpt-a', 'gpt-b'] });
    expect(models).toEqual(['gpt-a', 'gpt-b']);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('returns the configured Anthropic list without requesting /models', async () => {
    const models = await getAnthropicModels({ user: 'user-1', configuredModels: ['claude-a'] });
    expect(models).toEqual(['claude-a']);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('still discovers models when no list is configured', async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [{ id: 'gpt-discovered' }] } });
    await getOpenAIModels({ user: 'user-1' });
    expect(mockedAxios.get).toHaveBeenCalled();
  });
});

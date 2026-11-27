import { AuthType, EModelEndpoint } from 'librechat-data-provider';
import type { BaseInitializeParams } from '~/types';

const mockValidateEndpointURL = jest.fn();
jest.mock('~/auth', () => ({
  validateEndpointURL: (...args: unknown[]) => mockValidateEndpointURL(...args),
}));

const mockGetOpenAIConfig = jest.fn().mockReturnValue({
  llmConfig: { model: 'gpt-4' },
  configOptions: {},
});
jest.mock('./config', () => ({
  getOpenAIConfig: (...args: unknown[]) => mockGetOpenAIConfig(...args),
}));

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  getAzureCredentials: jest.fn(),
  resolveHeaders: jest.fn(() => ({})),
  isUserProvided: (val: string) => val === 'user_provided',
  checkUserKeyExpiry: jest.fn(),
}));

import { getAzureCredentials } from '~/utils';
import { initializeOpenAI } from './initialize';

function createParams(env: Record<string, string | undefined>): BaseInitializeParams {
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    savedEnv[key] = process.env[key];
  }
  Object.assign(process.env, env);

  const db = {
    getUserKeyValues: jest.fn().mockResolvedValue({
      apiKey: 'sk-user-key',
      baseURL: 'https://user-proxy.example.com/v1',
    }),
  } as unknown as BaseInitializeParams['db'];

  const params: BaseInitializeParams = {
    req: {
      user: { id: 'user-1' },
      body: { key: '2099-01-01' },
      config: { endpoints: {} },
    } as unknown as BaseInitializeParams['req'],
    endpoint: EModelEndpoint.openAI,
    model_parameters: { model: 'gpt-4' },
    db,
  };

  const restore = () => {
    for (const key of Object.keys(env)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  };

  return Object.assign(params, { _restore: restore });
}

describe('initializeOpenAI – SSRF guard wiring', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should call validateEndpointURL when OPENAI_REVERSE_PROXY is user_provided', async () => {
    const params = createParams({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_REVERSE_PROXY: AuthType.USER_PROVIDED,
    });

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    expect(mockValidateEndpointURL).toHaveBeenCalledTimes(1);
    expect(mockValidateEndpointURL).toHaveBeenCalledWith(
      'https://user-proxy.example.com/v1',
      EModelEndpoint.openAI,
      undefined,
    );
    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'sk-test',
      expect.objectContaining({
        reverseProxyUrl: 'https://user-proxy.example.com/v1',
        baseURLIsUserProvided: true,
        allowedAddresses: undefined,
      }),
      EModelEndpoint.openAI,
    );
  });

  it('should NOT call validateEndpointURL when OPENAI_REVERSE_PROXY is a system URL', async () => {
    const params = createParams({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_REVERSE_PROXY: 'https://api.openai.com/v1',
    });

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    expect(mockValidateEndpointURL).not.toHaveBeenCalled();
  });

  it('should NOT call validateEndpointURL when baseURL is falsy', async () => {
    const params = createParams({
      OPENAI_API_KEY: 'sk-test',
    });

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    expect(mockValidateEndpointURL).not.toHaveBeenCalled();
  });

  it('should propagate SSRF rejection from validateEndpointURL', async () => {
    mockValidateEndpointURL.mockRejectedValueOnce(
      new Error('Base URL for openAI targets a restricted address.'),
    );

    const params = createParams({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_REVERSE_PROXY: AuthType.USER_PROVIDED,
    });

    try {
      await expect(initializeOpenAI(params)).rejects.toThrow('targets a restricted address');
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    expect(mockGetOpenAIConfig).not.toHaveBeenCalled();
  });

  it('should not load stale user Azure values when an admin model group config is selected', async () => {
    const params = createParams({
      AZURE_API_KEY: AuthType.USER_PROVIDED,
      AZURE_OPENAI_BASEURL: AuthType.USER_PROVIDED,
    });
    (params.db.getUserKeyValues as jest.Mock).mockResolvedValue(null);
    params.endpoint = EModelEndpoint.azureOpenAI;
    params.model_parameters = { model: 'gpt-4o' };
    params.req.config = {
      endpoints: {
        [EModelEndpoint.azureOpenAI]: {
          modelGroupMap: {
            'gpt-4o': { group: 'serverless-group' },
          },
          groupMap: {
            'serverless-group': {
              apiKey: 'az-admin-key',
              baseURL: 'https://admin-azure.example.com/openai/deployments/gpt-4o',
              version: '2024-10-21',
              serverless: true,
            },
          },
        },
      },
    } as unknown as BaseInitializeParams['req']['config'];

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    expect(params.db.getUserKeyValues).not.toHaveBeenCalled();
    expect(mockValidateEndpointURL).not.toHaveBeenCalled();
    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'az-admin-key',
      expect.objectContaining({
        reverseProxyUrl: 'https://admin-azure.example.com/openai/deployments/gpt-4o',
        baseURLIsUserProvided: false,
      }),
      EModelEndpoint.azureOpenAI,
    );
  });
});

describe('initializeOpenAI – user-provided credentials', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('loads the stored API key when a resumed request omits expiry metadata', async () => {
    const params = createParams({ OPENAI_API_KEY: AuthType.USER_PROVIDED });
    params.req.body = {};

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    expect(params.db.getUserKeyValues).toHaveBeenCalledWith({
      userId: 'user-1',
      name: EModelEndpoint.openAI,
    });
    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'sk-user-key',
      expect.any(Object),
      EModelEndpoint.openAI,
    );
  });
});

describe('initializeOpenAI – custom headers', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('forwards Agent model transport timeout policy to OpenAI configuration', async () => {
    const params = createParams({ OPENAI_API_KEY: 'sk-test' });
    (params.req.config as { endpoints: Record<string, unknown> }).endpoints = {
      agents: {
        modelResponseBodyTimeoutMs: 1_800_000,
        modelResponseHeadersTimeoutMs: 120_000,
      },
    };

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    const options = mockGetOpenAIConfig.mock.calls[0][1] as {
      transportTimeouts?: { bodyTimeout: number; headersTimeout: number };
    };
    expect(options.transportTimeouts).toEqual({
      bodyTimeout: 1_800_000,
      headersTimeout: 120_000,
    });
  });

  it('forwards configured endpoint headers (merged over endpoints.all) to getOpenAIConfig', async () => {
    const params = createParams({ OPENAI_API_KEY: 'sk-test' });
    (params.req.config as { endpoints: Record<string, unknown> }).endpoints = {
      all: { headers: { 'X-Common': 'all', 'X-Override': 'all' } },
      [EModelEndpoint.openAI]: {
        headers: { 'X-Override': 'openai', 'cf-aig-metadata': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
      },
    };

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    const options = mockGetOpenAIConfig.mock.calls[0][1] as { headers?: Record<string, string> };
    expect(options.headers).toEqual({
      'X-Common': 'all',
      'X-Override': 'openai',
      'cf-aig-metadata': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
    });
  });

  it('does not set headers when none are configured', async () => {
    const params = createParams({ OPENAI_API_KEY: 'sk-test' });

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    const options = mockGetOpenAIConfig.mock.calls[0][1] as { headers?: Record<string, string> };
    expect(options.headers).toBeUndefined();
  });

  it('withholds configured headers when the user supplies the base URL', async () => {
    const params = createParams({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_REVERSE_PROXY: AuthType.USER_PROVIDED,
    });
    (params.req.config as { endpoints: Record<string, unknown> }).endpoints = {
      [EModelEndpoint.openAI]: { headers: { 'X-Secret': '${GATEWAY_SECRET}' } },
    };

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    const options = mockGetOpenAIConfig.mock.calls[0][1] as { headers?: Record<string, string> };
    expect(options.headers).toBeUndefined();
  });

  it('applies endpoints.all headers to the env-based Azure path, unresolved at init', async () => {
    (getAzureCredentials as jest.Mock).mockReturnValueOnce({ azureOpenAIApiKey: 'az-key' });
    const params = createParams({ AZURE_API_KEY: 'az-key' });
    params.endpoint = EModelEndpoint.azureOpenAI;
    (params.req.config as { endpoints: Record<string, unknown> }).endpoints = {
      all: { headers: { 'X-Global': '{{LIBRECHAT_USER_ID}}' } },
    };

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    const options = mockGetOpenAIConfig.mock.calls[0][1] as { headers?: Record<string, string> };
    // Left unresolved here; request-time resolveConfigHeaders resolves it once
    expect(options.headers).toEqual({ 'X-Global': '{{LIBRECHAT_USER_ID}}' });
  });
});

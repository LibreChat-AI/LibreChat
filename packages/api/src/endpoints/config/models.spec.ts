import { AuthType, EModelEndpoint } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';

const mockValidateEndpointURL = jest.fn().mockResolvedValue(undefined);
jest.mock('~/auth', () => ({
  validateEndpointURL: (...args: unknown[]) => mockValidateEndpointURL(...args),
}));

jest.mock('~/utils', () => {
  const original = jest.requireActual('~/utils');
  return {
    ...original,
    // Inline literal — jest.mock() factory may not reference imports.
    isUserProvided: (val: string) => val === 'user_provided',
  };
});

import { SCOPED_TOKEN_CONFIG_KEY_PREFIX } from '../keys';
import { createLoadConfigModels } from './models';

describe('createLoadConfigModels – user-provided baseURL header guard', () => {
  const fetchModels = jest.fn().mockResolvedValue([]);

  const buildAppConfig = (endpointOverrides: Record<string, unknown>) => ({
    endpoints: {
      [EModelEndpoint.custom]: [
        {
          name: 'TestProxy',
          baseURL: AuthType.USER_PROVIDED,
          apiKey: AuthType.USER_PROVIDED,
          models: { fetch: true },
          ...endpointOverrides,
        },
      ],
    },
  });

  beforeEach(() => {
    fetchModels.mockReset().mockResolvedValue([]);
    mockValidateEndpointURL.mockReset().mockResolvedValue(undefined);
  });

  it('does NOT forward configured headers when baseURL is user-provided', async () => {
    const headers = {
      Authorization: 'Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}',
      'X-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
    };

    const loadConfigModels = createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue(buildAppConfig({ headers })),
      getUserKeyValues: jest.fn().mockResolvedValue({
        apiKey: 'sk-user-key',
        baseURL: 'https://user-controlled.example.com/v1',
      }),
      fetchModels,
    });

    const req = {
      user: { id: 'user-1', email: 'user@example.com' },
      config: undefined,
    } as unknown as ServerRequest;

    await loadConfigModels(req);

    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(mockValidateEndpointURL).toHaveBeenCalledWith(
      'https://user-controlled.example.com/v1',
      'TestProxy',
      undefined,
    );
    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'TestProxy',
        baseURL: 'https://user-controlled.example.com/v1',
        baseURLIsUserProvided: true,
        headers: undefined,
      }),
    );
  });

  it('uses the user API key when baseURL is user-provided', async () => {
    const loadConfigModels = createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue(
        buildAppConfig({
          apiKey: 'sk-system-key',
        }),
      ),
      getUserKeyValues: jest.fn().mockResolvedValue({
        apiKey: 'sk-user-key',
        baseURL: 'https://user-controlled.example.com/v1',
      }),
      fetchModels,
    });

    const req = {
      user: { id: 'user-1', email: 'user@example.com' },
      config: undefined,
    } as unknown as ServerRequest;

    await loadConfigModels(req);

    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'TestProxy',
        apiKey: 'sk-user-key',
        baseURL: 'https://user-controlled.example.com/v1',
      }),
    );
    expect(fetchModels).not.toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-system-key',
      }),
    );
  });

  it('does NOT call fetchModels when user-provided baseURL validation fails', async () => {
    mockValidateEndpointURL.mockRejectedValueOnce(new Error('blocked SSRF target'));

    const loadConfigModels = createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue(buildAppConfig({})),
      getUserKeyValues: jest.fn().mockResolvedValue({
        apiKey: 'sk-user-key',
        baseURL: 'http://127.0.0.1:11434/v1',
      }),
      fetchModels,
    });

    const req = {
      user: { id: 'user-1' },
      config: undefined,
    } as unknown as ServerRequest;

    const modelsConfig = await loadConfigModels(req);

    expect(fetchModels).not.toHaveBeenCalled();
    expect(modelsConfig.TestProxy).toEqual([]);
  });

  it('DOES forward configured headers when baseURL is admin-trusted (only apiKey is user-provided)', async () => {
    const headers = {
      Authorization: 'Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}',
    };

    const loadConfigModels = createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.custom]: [
            {
              name: 'TrustedProxy',
              baseURL: 'https://admin-trusted.example.com/v1',
              apiKey: AuthType.USER_PROVIDED,
              models: { fetch: true },
              headers,
            },
          ],
        },
      }),
      getUserKeyValues: jest.fn().mockResolvedValue({
        apiKey: 'sk-user-key',
        baseURL: undefined,
      }),
      fetchModels,
    });

    const req = {
      user: { id: 'user-1' },
      config: undefined,
    } as unknown as ServerRequest;

    await loadConfigModels(req);

    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'TrustedProxy',
        baseURL: 'https://admin-trusted.example.com/v1',
        baseURLIsUserProvided: false,
        headers,
      }),
    );
  });

  it('tenant-scopes the fetched token config cache key for system-defined endpoints', async () => {
    const loadConfigModels = createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue(
        buildAppConfig({
          baseURL: 'https://admin-trusted.example.com/v1',
          apiKey: 'sk-system-key',
        }),
      ),
      getUserKeyValues: jest.fn(),
      fetchModels,
    });

    const req = {
      user: { id: 'user-1', tenantId: 'tenant-a' },
      config: undefined,
    } as unknown as ServerRequest;

    await loadConfigModels(req);

    expect(fetchModels).toHaveBeenCalledTimes(1);
    const tokenKey = fetchModels.mock.calls[0][0].tokenKey;
    expect(fetchModels.mock.calls[0][0].name).toBe('TestProxy');
    expect(tokenKey.startsWith(SCOPED_TOKEN_CONFIG_KEY_PREFIX)).toBe(true);
    expect(tokenKey).not.toBe('tenant:tenant-a:TestProxy');
    expect(tokenKey).not.toContain('tenant-a');
    expect(tokenKey).not.toContain('TestProxy');
  });
});

describe('createLoadConfigModels – in-request fetch coalescing', () => {
  const fetchModels = jest.fn().mockResolvedValue([]);

  beforeEach(() => {
    fetchModels.mockReset().mockResolvedValue([]);
  });

  it('does NOT coalesce two endpoints with the same baseURL+apiKey but different headers', async () => {
    const loadConfigModels = createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.custom]: [
            {
              name: 'TenantA',
              baseURL: 'https://shared-proxy.example.com/v1',
              apiKey: 'sk-shared',
              models: { fetch: true },
              headers: { 'X-Tenant': 'a' },
            },
            {
              name: 'TenantB',
              baseURL: 'https://shared-proxy.example.com/v1',
              apiKey: 'sk-shared',
              models: { fetch: true },
              headers: { 'X-Tenant': 'b' },
            },
          ],
        },
      }),
      getUserKeyValues: jest.fn(),
      fetchModels,
    });

    const req = {
      user: { id: 'user-1' },
      config: undefined,
    } as unknown as ServerRequest;

    await loadConfigModels(req);

    expect(fetchModels).toHaveBeenCalledTimes(2);
    const headersByName = new Map<string, Record<string, string> | undefined>();
    for (const call of fetchModels.mock.calls) {
      headersByName.set(call[0].name, call[0].headers);
    }
    expect(headersByName.get('TenantA')).toEqual({ 'X-Tenant': 'a' });
    expect(headersByName.get('TenantB')).toEqual({ 'X-Tenant': 'b' });
  });

  it('still coalesces two endpoints that share baseURL+apiKey AND identical headers', async () => {
    const sharedHeaders = { Authorization: 'Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}' };
    const loadConfigModels = createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.custom]: [
            {
              name: 'AliasOne',
              baseURL: 'https://shared-proxy.example.com/v1',
              apiKey: 'sk-shared',
              models: { fetch: true },
              headers: sharedHeaders,
            },
            {
              name: 'AliasTwo',
              baseURL: 'https://shared-proxy.example.com/v1',
              apiKey: 'sk-shared',
              models: { fetch: true },
              headers: sharedHeaders,
            },
          ],
        },
      }),
      getUserKeyValues: jest.fn(),
      fetchModels,
    });

    const req = {
      user: { id: 'user-1' },
      config: undefined,
    } as unknown as ServerRequest;

    await loadConfigModels(req);

    // Same baseURL + apiKey + headers → one fetch shared across both endpoints.
    expect(fetchModels).toHaveBeenCalledTimes(1);
  });
});

import type { AppConfig } from '@librechat/data-schemas';

describe('createLoadConfigModels - env var support for custom endpoint default models', () => {
  const originalEnv = process.env;
  const getUserKeyValues = jest.fn();
  const fetchModels = jest.fn();

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      MULTIPLE_MODELS: 'gpt-4o-mini, gpt-4o',
      SINGLE_MODEL: 'gpt-4.1',
    };

    getUserKeyValues.mockReset();
    fetchModels.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function buildAppConfig(includeFetch = false): AppConfig {
    return {
      endpoints: {
        [EModelEndpoint.custom]: [
          {
            name: 'custom',
            apiKey: 'test-api-key',
            baseURL: 'https://example.com',
            models: {
              default: ['${MULTIPLE_MODELS}', { name: '${SINGLE_MODEL}' }, 'claude-3-5-sonnet'],
              ...(includeFetch ? { fetch: true } : {}),
            },
          },
        ],
      },
    } as AppConfig;
  }

  function buildLoader(includeFetch = false) {
    return createLoadConfigModels({
      getAppConfig: async () => buildAppConfig(includeFetch),
      getUserKeyValues,
      fetchModels,
    });
  }

  it('expands comma-separated env vars in default model lists', async () => {
    const loadConfigModels = buildLoader(false);

    const result = await loadConfigModels({} as ServerRequest);

    expect(result.custom).toEqual(['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'claude-3-5-sonnet']);
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it('uses the same expansion when falling back after a fetch miss', async () => {
    const loadConfigModels = buildLoader(true);

    const result = await loadConfigModels({} as ServerRequest);

    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(result.custom).toEqual(['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'claude-3-5-sonnet']);
  });
});
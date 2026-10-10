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
import { createLoadConfigModels, configuredModelList } from './models';

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

describe('createLoadConfigModels � configured model lists for built-in endpoints', () => {
  const load = (endpoints: Record<string, unknown>, config?: Record<string, unknown>) =>
    createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue({ endpoints }),
      getUserKeyValues: jest.fn(),
      fetchModels: jest.fn(),
    })({ user: { id: 'user-1' }, config } as unknown as ServerRequest);

  it.each([
    EModelEndpoint.openAI,
    EModelEndpoint.google,
    EModelEndpoint.anthropic,
    EModelEndpoint.bedrock,
  ])('serves the %s list from config in place of its environment list', async (endpoint) => {
    const models = await load({ [endpoint]: { models: ['model-a', 'model-b'] } });
    expect(models[endpoint]).toEqual(['model-a', 'model-b']);
  });

  it('reads the per-request config, so principal overrides narrow the list', async () => {
    const models = await load(
      { [EModelEndpoint.anthropic]: { models: ['base-a', 'base-b'] } },
      { endpoints: { [EModelEndpoint.anthropic]: { models: ['narrowed'] } } },
    );
    expect(models[EModelEndpoint.anthropic]).toEqual(['narrowed']);
  });

  it('leaves endpoints without a configured list to their environment defaults', async () => {
    const models = await load({ [EModelEndpoint.openAI]: { streamRate: 25 } });
    expect(models).not.toHaveProperty(EModelEndpoint.openAI);
    expect(models).not.toHaveProperty(EModelEndpoint.anthropic);
  });

  it('keeps an explicitly empty list and drops non-string entries', async () => {
    const models = await load({
      [EModelEndpoint.google]: { models: [] },
      [EModelEndpoint.bedrock]: { models: ['ok', 42, null] },
    });
    expect(models[EModelEndpoint.google]).toEqual([]);
    expect(models[EModelEndpoint.bedrock]).toEqual(['ok']);
  });
});

describe('configuredModelList', () => {
  it('returns string entries of a configured list and undefined otherwise', () => {
    const appConfig = {
      endpoints: {
        [EModelEndpoint.openAI]: { models: ['a', 7, 'b'] },
        [EModelEndpoint.google]: { streamRate: 25 },
      },
    } as unknown as Parameters<typeof configuredModelList>[0];
    expect(configuredModelList(appConfig, EModelEndpoint.openAI)).toEqual(['a', 'b']);
    expect(configuredModelList(appConfig, EModelEndpoint.google)).toBeUndefined();
    expect(configuredModelList(undefined, EModelEndpoint.anthropic)).toBeUndefined();
  });
});

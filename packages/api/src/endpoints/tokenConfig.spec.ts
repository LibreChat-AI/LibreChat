import { EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { TokenomicsDeps } from './pricing';
import type { ServerRequest } from '~/types';

const mockCacheGet = jest.fn();
jest.mock('~/cache', () => ({
  tokenConfigCache: jest.fn(() => ({ get: (key: string) => mockCacheGet(key) })),
}));

import { resolveTokenConfigMap, createTokenConfigController } from './tokenConfig';
import { createLoadConfigModels } from './config/models';
import { createModelsService } from './config/service';
import { SCOPED_TOKEN_CONFIG_KEY_PREFIX } from './keys';

const deps: TokenomicsDeps = {
  getValueKey: () => 'value-key',
  getMultiplier: ({ tokenType }) => (tokenType === 'prompt' ? 5 : 15),
  getCacheMultiplier: () => null,
};

function appConfigWith(custom: unknown[], contextCost = true): AppConfig {
  return {
    interfaceConfig: { contextCost },
    endpoints: { [EModelEndpoint.custom]: custom },
  } as unknown as AppConfig;
}

describe('resolveTokenConfigMap', () => {
  beforeEach(() => mockCacheGet.mockReset().mockResolvedValue(null));

  it('uses a static tokenConfig override without consulting the cache', async () => {
    const appConfig = appConfigWith([
      {
        name: 'MyProxy',
        tokenConfig: { 'custom-model': { prompt: 1.5, completion: 4.5, context: 32000 } },
      },
    ]);

    const map = await resolveTokenConfigMap(
      { appConfig, modelsConfig: { MyProxy: ['custom-model'] }, userId: 'user-1' },
      deps,
    );

    expect(map.MyProxy['custom-model']).toEqual({ context: 32000, prompt: 1.5, completion: 4.5 });
    expect(mockCacheGet).not.toHaveBeenCalled();
  });

  it('falls back to the cached fetched config when no static override exists', async () => {
    mockCacheGet.mockResolvedValue({ 'custom-model': { prompt: 2, completion: 6, context: 8000 } });
    const appConfig = appConfigWith([{ name: 'MyProxy', models: { fetch: true } }]);

    const map = await resolveTokenConfigMap(
      { appConfig, modelsConfig: { MyProxy: ['custom-model'] }, userId: 'user-1' },
      deps,
    );

    expect(mockCacheGet).toHaveBeenCalled();
    expect(map.MyProxy['custom-model'].context).toBe(8000);
    expect(map.MyProxy['custom-model'].prompt).toBe(2);
  });

  it('uses a tenant-scoped cache key for fetched custom endpoint token config', async () => {
    mockCacheGet.mockImplementation(async (key: string) => {
      if (key.startsWith(SCOPED_TOKEN_CONFIG_KEY_PREFIX)) {
        return { 'custom-model': { prompt: 2, completion: 6, context: 16000 } };
      }
      if (key === 'MyProxy') {
        return { 'custom-model': { prompt: 12, completion: 24, context: 111111 } };
      }
      return null;
    });
    const appConfig = appConfigWith([{ name: 'MyProxy', models: { fetch: true } }]);

    const map = await resolveTokenConfigMap(
      {
        appConfig,
        modelsConfig: { MyProxy: ['custom-model'] },
        userId: 'user-2',
        tenantId: 'tenant-b',
      },
      deps,
    );

    const tokenKey = mockCacheGet.mock.calls[0][0];
    expect(tokenKey.startsWith(SCOPED_TOKEN_CONFIG_KEY_PREFIX)).toBe(true);
    expect(tokenKey).not.toBe('tenant:tenant-b:MyProxy');
    expect(tokenKey).not.toContain('tenant-b');
    expect(tokenKey).not.toContain('MyProxy');
    expect(map.MyProxy['custom-model'].context).toBe(16000);
    expect(map.MyProxy['custom-model'].prompt).toBe(2);
  });

  it('uses the legacy cache key when tenant context is unavailable or empty', async () => {
    mockCacheGet.mockResolvedValue({ 'custom-model': { prompt: 2, completion: 6, context: 8000 } });
    const appConfig = appConfigWith([{ name: 'MyProxy', models: { fetch: true } }]);
    const tenantIds = [undefined, null, '', '   '] as Array<string | null | undefined>;

    for (const tenantId of tenantIds) {
      mockCacheGet.mockClear();
      const map = await resolveTokenConfigMap(
        {
          appConfig,
          modelsConfig: { MyProxy: ['custom-model'] },
          userId: 'user-1',
          tenantId,
        },
        deps,
      );

      expect(mockCacheGet).toHaveBeenCalledWith('MyProxy');
      expect(mockCacheGet.mock.calls.every(([key]) => key === 'MyProxy')).toBe(true);
      expect(map.MyProxy['custom-model'].context).toBe(8000);
    }
  });

  it('omits pricing when contextCost is disabled', async () => {
    const appConfig = appConfigWith(
      [
        {
          name: 'MyProxy',
          tokenConfig: { 'custom-model': { prompt: 1.5, completion: 4.5, context: 32000 } },
        },
      ],
      false,
    );

    const map = await resolveTokenConfigMap(
      { appConfig, modelsConfig: { MyProxy: ['custom-model'] }, userId: 'user-1' },
      deps,
    );

    expect(map.MyProxy['custom-model'].context).toBe(32000);
    expect(map.MyProxy['custom-model'].prompt).toBeUndefined();
    expect(map.MyProxy['custom-model'].completion).toBeUndefined();
  });
});

describe('scoped token config controller', () => {
  const originalEndpoints = process.env.ENDPOINTS;
  beforeEach(() => {
    delete process.env.ENDPOINTS;
    mockCacheGet.mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    if (originalEndpoints == null) delete process.env.ENDPOINTS;
    else process.env.ENDPOINTS = originalEndpoints;
  });

  function setup(endpoint?: unknown) {
    const config = appConfigWith([
      {
        name: 'Selected',
        apiKey: 'admin-key',
        baseURL: 'https://selected.example/v1',
        models: { fetch: true, default: ['model'] },
        tokenConfig: { model: { context: 32000, prompt: 1, completion: 2 } },
      },
      {
        name: 'Unrelated',
        apiKey: 'user_provided',
        baseURL: 'https://unrelated.example/v1',
        models: { fetch: true },
      },
    ]);
    const getAppConfig = jest.fn().mockResolvedValue(config);
    const getUserKeyValues = jest.fn();
    const fetchModels = jest.fn().mockResolvedValue(['model']);
    const loadDefaultModels = jest.fn().mockResolvedValue({ openAI: ['gpt-4o'] });
    const loadAsyncEndpoints = jest.fn();
    const service = createModelsService({
      getAppConfig,
      loadConfigModels: createLoadConfigModels({ getAppConfig, getUserKeyValues, fetchModels }),
      loadDefaultModels,
      loadAsyncEndpoints,
      defaultEndpointsConfig: { openAI: { userProvide: false } },
    });
    const controller = createTokenConfigController({
      ...deps,
      getRequestModelsConfig: service.getRequestModelsConfig,
    });
    const req = {
      user: { id: 'user-1', tenantId: 'tenant-1' },
      config,
      query: endpoint === undefined ? {} : { endpoint },
    } as ServerRequest;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    return {
      controller,
      req,
      res,
      http: res as unknown as Response,
      getAppConfig,
      getUserKeyValues,
      fetchModels,
      loadDefaultModels,
      loadAsyncEndpoints,
    };
  }

  it('discovers only the selected endpoint and skips unrelated token-cache and credential reads', async () => {
    const test = setup('Selected');
    await test.controller(test.req, test.http);
    expect(test.res.json).toHaveBeenCalledWith({
      Selected: { model: { context: 32000, prompt: 1, completion: 2 } },
    });
    expect(test.fetchModels).toHaveBeenCalledTimes(1);
    expect(test.fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Selected', userObject: test.req.user }),
    );
    expect(test.getUserKeyValues).not.toHaveBeenCalled();
    expect(test.loadDefaultModels).not.toHaveBeenCalled();
    expect(test.loadAsyncEndpoints).not.toHaveBeenCalled();
    expect(test.getAppConfig).not.toHaveBeenCalled();
    expect(mockCacheGet).not.toHaveBeenCalled();
  });

  it('keeps aggregate discovery and response fields without a selector', async () => {
    const test = setup();
    await test.controller(test.req, test.http);
    expect(test.loadDefaultModels).toHaveBeenCalledWith(test.req);
    expect(test.res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        openAI: expect.any(Object),
        Selected: { model: { context: 32000, prompt: 1, completion: 2 } },
      }),
    );
  });

  it.each(['', ['Selected', 'Unrelated'], { name: 'Selected' }])(
    'rejects malformed selectors before discovery: %p',
    async (endpoint) => {
      const test = setup(endpoint);
      await test.controller(test.req, test.http);
      expect(test.res.status).toHaveBeenCalledWith(400);
      expect(test.fetchModels).not.toHaveBeenCalled();
      expect(test.loadDefaultModels).not.toHaveBeenCalled();
      expect(mockCacheGet).not.toHaveBeenCalled();
    },
  );

  it('rejects an endpoint absent from the principal config before discovery', async () => {
    const test = setup('Hidden');
    await test.controller(test.req, test.http);
    expect(test.res.status).toHaveBeenCalledWith(404);
    expect(test.fetchModels).not.toHaveBeenCalled();
    expect(test.getUserKeyValues).not.toHaveBeenCalled();
  });

  it('does not leak model-resolution failures', async () => {
    const test = setup('Selected');
    const controller = createTokenConfigController({
      ...deps,
      getRequestModelsConfig: jest.fn().mockRejectedValue(new Error('secret-provider-key')),
    });
    await controller(test.req, test.http);
    expect(test.res.status).toHaveBeenCalledWith(500);
    expect(test.res.json).toHaveBeenCalledWith({ error: 'Failed to resolve token config' });
  });

  it('reads a fetched token override only under the selected tenant/user scope', async () => {
    const appConfig = appConfigWith([
      {
        name: 'Selected',
        apiKey: 'user_provided',
        baseURL: 'https://selected.example/v1',
        models: { fetch: true },
      },
      { name: 'Unrelated', models: { fetch: true } },
    ]);
    mockCacheGet.mockResolvedValue({ model: { context: 16000 } });
    const map = await resolveTokenConfigMap(
      { appConfig, modelsConfig: { Selected: ['model'] }, userId: 'user-1', tenantId: 'tenant-1' },
      deps,
    );
    expect(map).toEqual({ Selected: { model: expect.objectContaining({ context: 16000 }) } });
    expect(mockCacheGet).toHaveBeenCalledTimes(1);
    expect(mockCacheGet.mock.calls[0][0].startsWith(SCOPED_TOKEN_CONFIG_KEY_PREFIX)).toBe(true);
  });
});

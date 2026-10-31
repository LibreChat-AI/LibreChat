import { FileSources } from 'librechat-data-provider';
import type { TModelsConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { createModelsService } from './service';

function request(endpoint?: unknown, config: AppConfig = { endpoints: {} } as AppConfig) {
  return {
    query: endpoint === undefined ? {} : { endpoint },
    user: { id: 'user-1', tenantId: 'tenant-1' },
    config,
  } as ServerRequest;
}

function response() {
  const res = {
    send: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  };
  return { res, http: res as unknown as Response };
}

function setup(config: AppConfig = { endpoints: {} } as AppConfig) {
  const deps = {
    getAppConfig: jest.fn().mockResolvedValue(config),
    loadDefaultModels: jest.fn(async (): Promise<TModelsConfig> => ({ openAI: ['default'] })),
    loadConfigModels: jest.fn(async (): Promise<TModelsConfig> => ({})),
    defaultEndpointsConfig: { openAI: { userProvide: false } },
    loadAsyncEndpoints: jest.fn().mockResolvedValue({ google: { userProvide: false } }),
    loadDefaultEndpointModels: jest.fn(
      async (): Promise<TModelsConfig> => ({ openAI: ['discovered'] }),
    ),
  };
  return { deps, ...createModelsService(deps) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('model discovery service', () => {
  const originalEndpoints = process.env.ENDPOINTS;
  beforeEach(() => {
    delete process.env.ENDPOINTS;
  });
  afterEach(() => {
    if (originalEndpoints == null) {
      delete process.env.ENDPOINTS;
    } else {
      process.env.ENDPOINTS = originalEndpoints;
    }
  });

  it('keeps aggregate loaders concurrent and configured models authoritative', async () => {
    const { deps, loadModels } = setup();
    const defaults = deferred<TModelsConfig>();
    const configured = deferred<TModelsConfig>();
    deps.loadDefaultModels.mockReturnValue(defaults.promise);
    deps.loadConfigModels.mockReturnValue(configured.promise);
    const req = request('ignored-by-internal-caller');
    const result = loadModels(req);
    expect(deps.loadDefaultModels).toHaveBeenCalledWith(req);
    expect(deps.loadConfigModels).toHaveBeenCalledWith(req);
    defaults.resolve({ openAI: ['default'], anthropic: ['claude'] });
    configured.resolve({ openAI: ['configured'], Custom: ['custom'] });
    await expect(result).resolves.toEqual({
      openAI: ['configured'],
      anthropic: ['claude'],
      Custom: ['custom'],
    });
    expect(deps.loadAsyncEndpoints).not.toHaveBeenCalled();
  });

  it('preserves the unscoped HTTP response', async () => {
    const { deps, modelController } = setup();
    const req = request();
    const { res, http } = response();
    deps.loadConfigModels.mockResolvedValue({ Custom: ['custom'] });
    await modelController(req, http);
    expect(res.send).toHaveBeenCalledWith({ openAI: ['default'], Custom: ['custom'] });
    expect(deps.getAppConfig).not.toHaveBeenCalled();
  });

  it('loads only the requested built-in and never probes unrelated Google credentials', async () => {
    const { deps, modelController } = setup();
    const req = request('openAI');
    const { res, http } = response();
    await modelController(req, http);
    expect(res.send).toHaveBeenCalledWith({ openAI: ['discovered'] });
    expect(deps.loadConfigModels).toHaveBeenCalledWith(
      expect.objectContaining({ config: req.config }),
      'openAI',
    );
    expect(deps.loadDefaultEndpointModels).toHaveBeenCalledWith(
      expect.objectContaining({ user: req.user }),
      req.config,
      'openAI',
    );
    expect(deps.getAppConfig).not.toHaveBeenCalled();
    expect(deps.loadDefaultModels).not.toHaveBeenCalled();
    expect(deps.loadAsyncEndpoints).not.toHaveBeenCalled();
  });

  it('reuses the resolved principal config for availability and discovery', async () => {
    const config = Object.assign(
      { config: {}, fileStrategy: FileSources.local, imageOutputType: 'png' } as AppConfig,
      { endpoints: { openAI: { models: ['narrowed'] } } },
    );
    const { deps, modelController } = setup(config);
    const req = request('openAI');
    delete req.config;
    const { res, http } = response();
    deps.loadConfigModels.mockResolvedValue({ openAI: ['narrowed'], Other: ['not-in-response'] });
    await modelController(req, http);
    expect(deps.getAppConfig).toHaveBeenCalledTimes(1);
    expect(deps.getAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1' }),
    );
    expect(deps.loadConfigModels).toHaveBeenCalledWith(
      expect.objectContaining({ config, user: req.user }),
      'openAI',
    );
    expect(deps.loadDefaultEndpointModels).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith({ openAI: ['narrowed'] });
  });

  it('keeps a configured empty list without provider discovery', async () => {
    const { deps, modelController } = setup();
    deps.loadConfigModels.mockResolvedValue({ openAI: [] });
    const { res, http } = response();
    await modelController(request('openAI'), http);
    expect(res.send).toHaveBeenCalledWith({ openAI: [] });
    expect(deps.loadDefaultEndpointModels).not.toHaveBeenCalled();
  });

  it('checks Google availability only when Google is selected', async () => {
    const { deps, modelController } = setup();
    deps.loadDefaultEndpointModels.mockResolvedValue({ google: ['gemini'] });
    const req = request('google');
    const { res, http } = response();
    await modelController(req, http);
    expect(deps.loadAsyncEndpoints).toHaveBeenCalledWith(req.config);
    expect(res.send).toHaveBeenCalledWith({ google: ['gemini'] });
  });

  it('rejects unavailable Google without invoking any discovery loader', async () => {
    const { deps, modelController } = setup();
    deps.loadAsyncEndpoints.mockResolvedValue({ google: false });
    const { res, http } = response();
    await modelController(request('google'), http);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(deps.loadConfigModels).not.toHaveBeenCalled();
    expect(deps.loadDefaultEndpointModels).not.toHaveBeenCalled();
  });

  it('serves YAML Azure configuration even without environment credentials', async () => {
    const { deps, modelController } = setup();
    deps.loadConfigModels.mockResolvedValue({ azureOpenAI: ['deployment'] });
    const config = { endpoints: { azureOpenAI: { modelNames: ['deployment'] } } } as AppConfig;
    const { res, http } = response();
    await modelController(request('azureOpenAI', config), http);
    expect(res.send).toHaveBeenCalledWith({ azureOpenAI: ['deployment'] });
    expect(deps.loadDefaultEndpointModels).not.toHaveBeenCalled();
    expect(deps.loadAsyncEndpoints).not.toHaveBeenCalled();
  });

  it.each(['Unknown', '__proto__', 'constructor', 'custom', 'anthropic'])(
    'rejects unserved endpoint %s before discovery',
    async (endpoint) => {
      const { deps, modelController } = setup();
      const { res, http } = response();
      await modelController(request(endpoint), http);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(deps.loadConfigModels).not.toHaveBeenCalled();
      expect(deps.loadDefaultModels).not.toHaveBeenCalled();
      expect(deps.loadDefaultEndpointModels).not.toHaveBeenCalled();
      expect(deps.loadAsyncEndpoints).not.toHaveBeenCalled();
    },
  );

  it('does not serve a built-in disabled by ENDPOINTS', async () => {
    process.env.ENDPOINTS = 'agents';
    const { deps, modelController } = setup();
    const { res, http } = response();
    await modelController(request('openAI'), http);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(deps.loadConfigModels).not.toHaveBeenCalled();
  });

  it('serves custom names with exact casing even when built-ins are disabled', async () => {
    process.env.ENDPOINTS = 'agents';
    const config = {
      endpoints: {
        custom: [
          {
            name: 'My Proxy / A&B',
            apiKey: 'key',
            baseURL: 'https://proxy.example/v1',
            models: { default: ['custom'] },
          },
        ],
      },
    } as AppConfig;
    const { deps, modelController } = setup();
    deps.loadConfigModels.mockResolvedValue({ 'My Proxy / A&B': ['custom'] });
    const { res, http } = response();
    await modelController(request('My Proxy / A&B', config), http);
    expect(res.send).toHaveBeenCalledWith({ 'My Proxy / A&B': ['custom'] });
    expect(deps.loadDefaultEndpointModels).not.toHaveBeenCalled();
  });

  it.each(['', ['openAI', 'anthropic'], { name: 'openAI' }])(
    'rejects malformed selectors without config I/O: %p',
    async (endpoint) => {
      const { deps, modelController } = setup();
      const { res, http } = response();
      await modelController(request(endpoint), http);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(deps.getAppConfig).not.toHaveBeenCalled();
      expect(deps.loadConfigModels).not.toHaveBeenCalled();
    },
  );

  it('does not expose configuration failures or secrets', async () => {
    const { deps, modelController } = setup();
    deps.getAppConfig.mockRejectedValue(new Error('secret-key and private provider URL'));
    const req = request('openAI');
    delete req.config;
    const { res, http } = response();
    await modelController(req, http);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.send).toHaveBeenCalledWith({ error: 'Failed to load models' });
    expect(deps.loadConfigModels).not.toHaveBeenCalled();
  });
});

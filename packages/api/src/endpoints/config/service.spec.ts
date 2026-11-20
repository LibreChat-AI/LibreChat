import { FileSources, resolveModelCatalogKey } from 'librechat-data-provider';
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

describe('per-endpoint model loading', () => {
  const hasOwn = (catalog: TModelsConfig, key: string) =>
    Object.prototype.hasOwnProperty.call(catalog, key);
  const builtIns: TModelsConfig = {
    openAI: ['gpt-default'],
    anthropic: ['claude-default'],
    google: ['gemini-default'],
    azureOpenAI: ['azure-default'],
    assistants: ['assistant-default'],
    azureAssistants: ['azure-assistant-default'],
    bedrock: ['bedrock-default'],
  };
  const served: TModelsConfig = {
    anthropic: ['claude-configured'],
    ollama: ['llama3.2'],
    'My Proxy': ['proxy-model'],
  };

  /**
   * Stand-in loaders that return the full catalog without a name and one entry with it. They test
   * the service's own rules (lookup order, one load per request, no other endpoint loaded); that
   * the entry equals the full catalog's under the real loaders is checked in
   * `api/server/services/Config/catalog.spec.js`.
   */
  function world(extra: TModelsConfig = {}) {
    const configured = { ...served, ...extra };
    const deps = {
      getAppConfig: jest.fn().mockResolvedValue({ endpoints: {} } as AppConfig),
      loadDefaultModels: jest.fn(async (): Promise<TModelsConfig> => ({ ...builtIns })),
      loadConfigModels: jest.fn(
        async (_req: ServerRequest, endpoint?: string): Promise<TModelsConfig> => {
          if (endpoint == null) {
            return { ...configured };
          }
          return hasOwn(configured, endpoint) ? { [endpoint]: configured[endpoint] } : {};
        },
      ),
      defaultEndpointsConfig: { openAI: { userProvide: false } },
      loadAsyncEndpoints: jest.fn().mockResolvedValue({}),
      loadDefaultEndpointModels: jest.fn(
        async (
          _req: ServerRequest,
          _config: AppConfig,
          endpoint: string,
        ): Promise<TModelsConfig> =>
          hasOwn(builtIns, endpoint) ? { [endpoint]: builtIns[endpoint] } : {},
      ),
    };
    return { deps, ...createModelsService(deps) };
  }

  /** The lookup agent validation performs on a catalog. */
  const lookup = (catalog: TModelsConfig, provider: string) =>
    catalog[resolveModelCatalogKey(provider, catalog)];

  it.each([
    ['a built-in without a configured list', 'openAI', ['gpt-default']],
    ['a built-in with a configured list', 'anthropic', ['claude-configured']],
    ['a served custom endpoint', 'My Proxy', ['proxy-model']],
    ['a custom endpoint saved under another spelling', 'Ollama', ['llama3.2']],
    ['a provider served under an alias', 'vertexai', ['gemini-default']],
    ['an endpoint with no model list', 'Unknown', undefined],
  ])('reads %s', async (_label, provider, models) => {
    const { getEndpointModelsConfig } = world();

    const entry = await getEndpointModelsConfig(request(), provider);

    expect(lookup(entry, provider)).toEqual(models);
    expect(Object.keys(entry).length).toBeLessThanOrEqual(1);
  });

  it('prefers an exact catalog over the alias', async () => {
    const { getEndpointModelsConfig } = world({ vertexai: ['custom-vertex'] });

    const entry = await getEndpointModelsConfig(request(), 'vertexai');

    expect(lookup(entry, 'vertexai')).toEqual(['custom-vertex']);
  });

  it('loads the requested endpoint and no other', async () => {
    const { deps, getEndpointModelsConfig } = world();
    const req = request();

    await getEndpointModelsConfig(req, 'openAI');
    await getEndpointModelsConfig(req, 'My Proxy');

    expect(deps.loadDefaultModels).not.toHaveBeenCalled();
    expect(deps.loadConfigModels.mock.calls.map(([, endpoint]) => endpoint)).toEqual([
      'openAI',
      'My Proxy',
    ]);
    expect(deps.loadDefaultEndpointModels.mock.calls.map(([, , endpoint]) => endpoint)).toEqual([
      'openAI',
    ]);
  });

  it('loads an endpoint once per request, including concurrent and repeated calls', async () => {
    const { deps, getEndpointModelsConfig } = world();
    const gate = deferred<TModelsConfig>();
    deps.loadConfigModels.mockReturnValueOnce(gate.promise);
    const req = request();

    const first = getEndpointModelsConfig(req, 'My Proxy');
    const second = getEndpointModelsConfig(req, 'My Proxy');
    gate.resolve({ 'My Proxy': ['proxy-model'] });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { 'My Proxy': ['proxy-model'] },
      { 'My Proxy': ['proxy-model'] },
    ]);
    await getEndpointModelsConfig(req, 'My Proxy');
    expect(deps.loadConfigModels).toHaveBeenCalledTimes(1);
  });

  it('shares the load between spellings that read the same endpoint', async () => {
    const { deps, getEndpointModelsConfig } = world();
    const req = request();

    await getEndpointModelsConfig(req, 'ollama');
    await getEndpointModelsConfig(req, 'Ollama');

    expect(deps.loadConfigModels.mock.calls.filter(([, name]) => name === 'ollama')).toHaveLength(
      1,
    );
  });

  it('does not cache across requests', async () => {
    const { deps, getEndpointModelsConfig } = world();

    await getEndpointModelsConfig(request(), 'My Proxy');
    await getEndpointModelsConfig(request(), 'My Proxy');

    expect(deps.loadConfigModels).toHaveBeenCalledTimes(2);
  });

  it('does not remember a failed load', async () => {
    const { deps, getEndpointModelsConfig } = world();
    deps.loadConfigModels.mockRejectedValueOnce(new Error('provider down'));
    const req = request();

    await expect(getEndpointModelsConfig(req, 'My Proxy')).rejects.toThrow('provider down');
    await expect(getEndpointModelsConfig(req, 'My Proxy')).resolves.toEqual({
      'My Proxy': ['proxy-model'],
    });
  });

  it('loads built-ins that ENDPOINTS does not enable', async () => {
    const original = process.env.ENDPOINTS;
    process.env.ENDPOINTS = 'agents';
    try {
      const { getEndpointModelsConfig } = world();

      await expect(getEndpointModelsConfig(request(), 'bedrock')).resolves.toEqual({
        bedrock: ['bedrock-default'],
      });
    } finally {
      if (original == null) {
        delete process.env.ENDPOINTS;
      } else {
        process.env.ENDPOINTS = original;
      }
    }
  });

  it('resolves the principal config once for the request', async () => {
    const { deps, getEndpointModelsConfig } = world();
    const req = request();
    delete req.config;

    await getEndpointModelsConfig(req, 'openAI');
    await getEndpointModelsConfig(req, 'My Proxy');

    expect(deps.getAppConfig).toHaveBeenCalledTimes(1);
    expect(deps.loadConfigModels).toHaveBeenCalledWith(
      expect.objectContaining({ config: { endpoints: {} } }),
      'openAI',
    );
  });

  it.each([undefined, null, '', 42, ['openAI'], { name: 'openAI' }])(
    'loads nothing for the unusable endpoint %p',
    async (endpoint) => {
      const { deps, getEndpointModelsConfig } = world();

      await expect(
        getEndpointModelsConfig(request(), endpoint as string | null | undefined),
      ).resolves.toEqual({});
      expect(deps.getAppConfig).not.toHaveBeenCalled();
      expect(deps.loadConfigModels).not.toHaveBeenCalled();
      expect(deps.loadDefaultEndpointModels).not.toHaveBeenCalled();
    },
  );
});

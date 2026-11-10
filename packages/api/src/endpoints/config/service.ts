import { logger } from '@librechat/data-schemas';
import {
  EModelEndpoint,
  getEnabledEndpoints,
  resolveModelCatalogKey,
} from 'librechat-data-provider';
import type { TModelsConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { GetAppConfigOptions } from '~/app/service';
import type { EndpointsConfigDeps } from './endpoints';
import type { ServerRequest } from '~/types';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { createEndpointsConfigService } from './endpoints';
import { loadDefaultEndpointModels } from './defaults';
import { getSafeErrorMetadata } from '~/utils/errors';

type EndpointConfig = Awaited<ReturnType<EndpointsConfigDeps['loadDefaultEndpointsConfig']>>;
type ModelLoader = (req: ServerRequest, endpoint?: string) => Promise<TModelsConfig>;

export type RequestModelsConfigResult =
  | { ok: true; modelsConfig: TModelsConfig }
  | { ok: false; status: 400 | 404; error: string };

export interface ModelsServiceDeps {
  getAppConfig: (params: GetAppConfigOptions) => Promise<AppConfig>;
  loadDefaultModels: ModelLoader;
  loadConfigModels: ModelLoader;
  defaultEndpointsConfig: EndpointConfig;
  loadAsyncEndpoints: (config: AppConfig) => Promise<EndpointConfig>;
  loadDefaultEndpointModels?: typeof loadDefaultEndpointModels;
}

function hasEntry(catalog: TModelsConfig, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(catalog, key) && catalog[key] != null;
}

export function createModelsService(deps: ModelsServiceDeps): {
  modelController: (req: ServerRequest, res: Response) => Promise<Response>;
  loadModels: (req: ServerRequest) => Promise<TModelsConfig>;
  getModelsConfig: (req: ServerRequest) => Promise<TModelsConfig>;
  getRequestModelsConfig: (req: ServerRequest) => Promise<RequestModelsConfigResult>;
  getEndpointModelsConfig: (
    req: ServerRequest,
    endpoint: string | null | undefined,
  ) => Promise<TModelsConfig>;
} {
  /** Catalog entries loaded for a request, by the endpoint name they were requested under. */
  const requestEntries = new WeakMap<ServerRequest, Map<string, Promise<TModelsConfig>>>();

  /** Internal callers keep the full catalog, regardless of HTTP query parameters. */
  async function loadModels(req: ServerRequest): Promise<TModelsConfig> {
    const [defaults, configured] = await Promise.all([
      deps.loadDefaultModels(req),
      deps.loadConfigModels(req),
    ]);
    return { ...defaults, ...configured };
  }

  async function resolveConfig(req: ServerRequest): Promise<AppConfig> {
    const config = req.config ?? (await deps.getAppConfig(getAppConfigOptionsFromUser(req.user)));
    req.config = config;
    return config;
  }

  /**
   * What the full catalog holds under one endpoint name: `{ [endpoint]: models }`, or `{}` when
   * the name is neither a configured list, a served custom endpoint nor a built-in provider.
   */
  async function loadEndpointModels(
    req: ServerRequest,
    config: AppConfig,
    endpoint: string,
  ): Promise<TModelsConfig> {
    const configured = await deps.loadConfigModels(req, endpoint);
    if (Object.prototype.hasOwnProperty.call(configured, endpoint)) {
      return { [endpoint]: configured[endpoint] };
    }
    return (deps.loadDefaultEndpointModels ?? loadDefaultEndpointModels)(req, config, endpoint);
  }

  /** One load per request and endpoint name, shared while in flight and kept once settled. */
  function loadRequestEntry(req: ServerRequest, endpoint: string): Promise<TModelsConfig> {
    let entries = requestEntries.get(req);
    if (entries == null) {
      entries = new Map();
      requestEntries.set(req, entries);
    }
    const loaded = entries.get(endpoint);
    if (loaded != null) {
      return loaded;
    }
    const known = entries;
    const pending: Promise<TModelsConfig> = resolveConfig(req)
      .then((config) => loadEndpointModels(req, config, endpoint))
      .catch((error: unknown) => {
        /** A failed load is not remembered, so a later validation in the request may retry. */
        if (known.get(endpoint) === pending) {
          known.delete(endpoint);
        }
        throw error;
      });
    known.set(endpoint, pending);
    return pending;
  }

  async function getRequestModelsConfig(req: ServerRequest): Promise<RequestModelsConfigResult> {
    const endpoint = req.query.endpoint;
    if (endpoint != null && (typeof endpoint !== 'string' || endpoint.length === 0)) {
      return { ok: false, status: 400, error: 'Invalid endpoint' };
    }
    if (endpoint == null) {
      return { ok: true, modelsConfig: await loadModels(req) };
    }
    const config = await resolveConfig(req);
    const { getEndpointsConfig } = createEndpointsConfigService({
      getAppConfig: deps.getAppConfig,
      loadDefaultEndpointsConfig: async () => {
        const enabled = getEnabledEndpoints();
        const defaults: EndpointConfig = {};
        for (const name of enabled) {
          if (
            Object.prototype.hasOwnProperty.call(EModelEndpoint, name) &&
            deps.defaultEndpointsConfig[name]
          ) {
            defaults[name] = deps.defaultEndpointsConfig[name];
          }
        }
        // Google availability may read a service-key file. Never probe it for other endpoints.
        if (endpoint === EModelEndpoint.google && enabled.includes(endpoint)) {
          Object.assign(defaults, await deps.loadAsyncEndpoints(config));
        }
        return defaults;
      },
    });
    const endpoints = await getEndpointsConfig(req);
    if (!Object.prototype.hasOwnProperty.call(endpoints, endpoint)) {
      return { ok: false, status: 404, error: 'Endpoint not found' };
    }
    const loaded = await loadEndpointModels(req, config, endpoint);
    return { ok: true, modelsConfig: { [endpoint]: loaded[endpoint] ?? [] } };
  }

  /**
   * The part of the full catalog that `resolveModelCatalogKey(endpoint, catalog)` reads for an
   * agent provider or request endpoint: the entry under the exact name when the catalog has one,
   * otherwise the entry under the alias or served name it falls back to (`vertexai` reads
   * `google`, `Ollama` reads `ollama`). No other endpoint is loaded, and nothing is gated on the
   * endpoint being enabled, as in the full catalog. Built-in defaults come from the same source
   * as `GET /api/models?endpoint=`. Entries are loaded once per request and endpoint name.
   */
  async function getEndpointModelsConfig(
    req: ServerRequest,
    endpoint: string | null | undefined,
  ): Promise<TModelsConfig> {
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      return {};
    }
    const exact = await loadRequestEntry(req, endpoint);
    if (hasEntry(exact, endpoint)) {
      return exact;
    }
    const key = resolveModelCatalogKey(endpoint, {});
    return key === endpoint ? exact : loadRequestEntry(req, key);
  }

  async function modelController(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const result = await getRequestModelsConfig(req);
      if (!result.ok) {
        return res.status(result.status).send({ error: result.error });
      }
      return res.send(result.modelsConfig);
    } catch (error) {
      logger.error('Error fetching models:', getSafeErrorMetadata(error));
      return res.status(500).send({ error: 'Failed to load models' });
    }
  }

  return {
    modelController,
    loadModels,
    getModelsConfig: loadModels,
    getRequestModelsConfig,
    getEndpointModelsConfig,
  };
}

import { logger } from '@librechat/data-schemas';
import { EModelEndpoint, getEnabledEndpoints } from 'librechat-data-provider';
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

export function createModelsService(deps: ModelsServiceDeps): {
  modelController: (req: ServerRequest, res: Response) => Promise<Response>;
  loadModels: (req: ServerRequest) => Promise<TModelsConfig>;
  getModelsConfig: (req: ServerRequest) => Promise<TModelsConfig>;
  getRequestModelsConfig: (req: ServerRequest) => Promise<RequestModelsConfigResult>;
} {
  /** Internal callers keep the full catalog, regardless of HTTP query parameters. */
  async function loadModels(req: ServerRequest): Promise<TModelsConfig> {
    const [defaults, configured] = await Promise.all([
      deps.loadDefaultModels(req),
      deps.loadConfigModels(req),
    ]);
    return { ...defaults, ...configured };
  }

  async function getRequestModelsConfig(req: ServerRequest): Promise<RequestModelsConfigResult> {
    const endpoint = req.query.endpoint;
    if (endpoint != null && (typeof endpoint !== 'string' || endpoint.length === 0)) {
      return { ok: false, status: 400, error: 'Invalid endpoint' };
    }
    if (endpoint == null) {
      return { ok: true, modelsConfig: await loadModels(req) };
    }
    const config = req.config ?? (await deps.getAppConfig(getAppConfigOptionsFromUser(req.user)));
    req.config = config;
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
    const configured = await deps.loadConfigModels(req, endpoint);
    if (Object.prototype.hasOwnProperty.call(configured, endpoint)) {
      return { ok: true, modelsConfig: { [endpoint]: configured[endpoint] } };
    }
    const models = await (deps.loadDefaultEndpointModels ?? loadDefaultEndpointModels)(
      req,
      config,
      endpoint,
    );
    return { ok: true, modelsConfig: { [endpoint]: models[endpoint] ?? [] } };
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

  return { modelController, loadModels, getModelsConfig: loadModels, getRequestModelsConfig };
}

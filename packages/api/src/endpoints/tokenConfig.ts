import { logger } from '@librechat/data-schemas';
import { EModelEndpoint, normalizeEndpointName } from 'librechat-data-provider';
import type { TModelsConfig, TTokenConfigMap, TEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { EndpointTokenConfig, ServerRequest } from '~/types';
import type { RequestModelsConfigResult } from './config/service';
import type { TokenomicsDeps } from '~/endpoints/pricing';
import { getTokenConfigKey } from '~/endpoints/custom/initialize';
import { buildTokenConfigMap } from '~/endpoints/pricing';
import { getSafeErrorMetadata } from '~/utils/errors';
import { tokenConfigCache } from '~/cache';

export interface ResolveTokenConfigParams {
  appConfig?: AppConfig;
  /** endpoint → model list, from the resolved models config */
  modelsConfig: TModelsConfig;
  userId: string;
  tenantId?: string | null;
}

/**
 * Server-side token-config resolution for the `/endpoints/token-config`
 * route. Gathers each custom endpoint's override — a static yaml `tokenConfig`
 * or the cached fetched config — then resolves context windows (and pricing,
 * when `interface.contextCost` is enabled) via {@link buildTokenConfigMap}.
 * Lives in TypeScript so the `/api` controller stays a thin wrapper.
 */
export async function resolveTokenConfigMap(
  { appConfig, modelsConfig, userId, tenantId }: ResolveTokenConfigParams,
  deps: TokenomicsDeps,
): Promise<TTokenConfigMap> {
  const includePricing = appConfig?.interfaceConfig?.contextCost === true;
  const customEndpoints = (appConfig?.endpoints?.[EModelEndpoint.custom] ?? []) as TEndpoint[];
  const cache = tokenConfigCache();
  const endpointTokenConfigs: Record<string, EndpointTokenConfig | undefined> = {};

  for (const endpointConfig of customEndpoints) {
    /** Models config and the token-config cache key by the normalized name */
    const name = normalizeEndpointName(endpointConfig?.name);
    if (!name || !Object.prototype.hasOwnProperty.call(modelsConfig, name)) {
      continue;
    }
    if (endpointConfig.tokenConfig != null) {
      endpointTokenConfigs[name] = endpointConfig.tokenConfig as EndpointTokenConfig;
      continue;
    }
    /** Model fetches and chat initialization both store under this key —
     *  user-scoped whenever the fetched config can be user-specific */
    const tokenKey = getTokenConfigKey(endpointConfig, name, userId, tenantId);
    const cached = (await cache.get(tokenKey)) as EndpointTokenConfig | undefined;
    if (cached) {
      endpointTokenConfigs[name] = cached;
    }
  }

  return buildTokenConfigMap({ modelsConfig, endpointTokenConfigs, includePricing }, deps);
}

export interface TokenConfigControllerDeps extends TokenomicsDeps {
  getRequestModelsConfig: (req: ServerRequest) => Promise<RequestModelsConfigResult>;
}

export function createTokenConfigController(
  deps: TokenConfigControllerDeps,
): (req: ServerRequest, res: Response) => Promise<Response> {
  return async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const result = await deps.getRequestModelsConfig(req);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      const map = await resolveTokenConfigMap(
        {
          appConfig: req.config,
          modelsConfig: result.modelsConfig,
          userId: req.user.id,
          tenantId: req.user.tenantId,
        },
        deps,
      );
      const endpoint = req.query.endpoint;
      return res.json(typeof endpoint === 'string' ? { [endpoint]: map[endpoint] ?? {} } : map);
    } catch (error) {
      logger.error('[tokenConfigController]', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to resolve token config' });
    }
  };
}

import { logger } from '@librechat/data-schemas';
import { EModelEndpoint, normalizeEndpointName } from 'librechat-data-provider';
import type { TEndpointsConfig, TModelsConfig, TEndpoint, TConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';

/**
 * Names of the custom endpoints whose served list is decided by `models.filter`.
 * `filter` requires `fetch` — without a fetched catalog there is nothing to
 * intersect against. Keyed by `normalizeEndpointName`, matching the models config.
 */
export function filterManagedEndpoints(appConfig?: AppConfig | null): Set<string> {
  const managed = new Set<string>();
  const custom = appConfig?.endpoints?.[EModelEndpoint.custom] as TEndpoint[] | undefined;
  if (!Array.isArray(custom)) {
    return managed;
  }

  for (const endpoint of custom) {
    if (endpoint?.name && endpoint.models?.filter && endpoint.models.fetch) {
      managed.add(normalizeEndpointName(endpoint.name));
    }
  }
  return managed;
}

/**
 * Removes filter-managed custom endpoints with no models available to the
 * request — an empty model list renders as an empty picker entry and an
 * unusable Agent Builder provider. User-provided endpoints are kept: their
 * empty list reflects the user's own key, and the picker entry is the route to
 * fixing it. Fails open when the models config is absent or has no entry for
 * an endpoint.
 */
export function withholdEmptyEndpoints(
  endpointsConfig: TEndpointsConfig,
  modelsConfig: TModelsConfig | null | undefined,
  filterManaged: ReadonlySet<string>,
): TEndpointsConfig {
  if (endpointsConfig == null || modelsConfig == null || filterManaged.size === 0) {
    return endpointsConfig;
  }

  const available: Record<string, TConfig | null | undefined> = {};
  for (const [name, config] of Object.entries(endpointsConfig)) {
    const models = modelsConfig[name];
    const withhold =
      filterManaged.has(name) &&
      config?.type === EModelEndpoint.custom &&
      !config.userProvide &&
      !config.userProvideURL &&
      Array.isArray(models) &&
      models.length === 0;

    if (withhold) {
      logger.debug(`[withholdEmptyEndpoints] "${name}": no models available for this request`);
      continue;
    }
    available[name] = config;
  }

  return available;
}

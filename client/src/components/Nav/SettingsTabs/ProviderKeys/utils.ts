import { EModelEndpoint, isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type { TConfig, TSpecsConfig, TEndpointsConfig } from 'librechat-data-provider';

/**
 * Whether an endpoint config requires a user-provided credential — an API key or
 * any Bedrock credential field. `userProvideURL` alone is excluded: a user-provided
 * base URL does not imply a user-managed key.
 */
export const isUserProvidedEndpointConfig = (config?: TConfig | null): boolean => {
  if (!config) {
    return false;
  }
  return (
    !!config.userProvide ||
    !!config.userProvideAccessKeyId ||
    !!config.userProvideSecretAccessKey ||
    !!config.userProvideSessionToken ||
    !!config.userProvideBearerToken
  );
};

/**
 * The endpoints a user can actually reach, mirroring the model selector and mention
 * popover. With no modelSpecs every configured endpoint is reachable. When modelSpecs
 * are configured the catalog is limited to the endpoints referenced by the specs plus
 * `modelSpecs.addedEndpoints`; if agents are reachable the set additionally includes
 * the agent `allowedProviders` (all providers when left unrestricted).
 */
const getReachableEndpoints = ({
  endpointsConfig,
  modelSpecs,
  hasAgentAccess,
}: {
  endpointsConfig: NonNullable<TEndpointsConfig>;
  modelSpecs?: Pick<TSpecsConfig, 'list' | 'addedEndpoints'> | null;
  hasAgentAccess: boolean;
}): Set<string> => {
  const allEndpoints = Object.keys(endpointsConfig);
  const specs = modelSpecs?.list ?? [];
  if (specs.length === 0) {
    return new Set(allEndpoints);
  }

  const reachable = new Set<string>();
  for (const spec of specs) {
    const specEndpoint = spec.preset?.endpoint;
    if (specEndpoint) {
      reachable.add(specEndpoint);
    }
  }
  for (const endpoint of modelSpecs?.addedEndpoints ?? []) {
    reachable.add(endpoint);
  }

  if (!hasAgentAccess || !reachable.has(EModelEndpoint.agents)) {
    return reachable;
  }

  const allowedProviders = endpointsConfig[EModelEndpoint.agents]?.allowedProviders ?? [];
  if (allowedProviders.length > 0) {
    for (const provider of allowedProviders) {
      reachable.add(provider);
    }
    return reachable;
  }

  for (const endpoint of allEndpoints) {
    if (!isAgentsEndpoint(endpoint) && !isAssistantsEndpoint(endpoint)) {
      reachable.add(endpoint);
    }
  }
  return reachable;
};

/**
 * Reachable endpoints that require a user-provided credential — the endpoints whose
 * keys can be set or rotated from the API keys settings section.
 */
export const getUserKeyEndpoints = ({
  endpointsConfig,
  modelSpecs,
  hasAgentAccess,
}: {
  endpointsConfig?: TEndpointsConfig | null;
  modelSpecs?: Pick<TSpecsConfig, 'list' | 'addedEndpoints'> | null;
  hasAgentAccess: boolean;
}): string[] => {
  if (!endpointsConfig) {
    return [];
  }
  const reachable = getReachableEndpoints({ endpointsConfig, modelSpecs, hasAgentAccess });
  const result: string[] = [];
  for (const [endpoint, config] of Object.entries(endpointsConfig)) {
    if (reachable.has(endpoint) && isUserProvidedEndpointConfig(config)) {
      result.push(endpoint);
    }
  }
  return result;
};

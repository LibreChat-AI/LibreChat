import {
  alternateName,
  EModelEndpoint,
  isAgentsEndpoint,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import type {
  TConfig,
  TSpecsConfig,
  TEndpointsConfig,
  MediaStartupConfig,
  MediaUserKey,
} from 'librechat-data-provider';
import { mergeMediaUserKeys } from '~/components/Media/credentials';

export type ProviderKeyEntry = {
  endpoint: string;
  keyName: string;
  label: string;
  conflict: boolean;
  keyConfiguration?: MediaUserKey & { label: string };
};

/** Merge by saved credential identity, preserving chat forms and detecting incompatible envelopes. */
export function getProviderKeyEntries({
  chatEndpoints,
  endpointsConfig,
  mediaIntegrations,
}: {
  chatEndpoints: string[];
  endpointsConfig?: TEndpointsConfig | null;
  mediaIntegrations?: MediaStartupConfig['integrations'];
}): ProviderKeyEntry[] {
  const entries = new Map<string, ProviderKeyEntry>();
  for (const endpoint of chatEndpoints) {
    const config = endpointsConfig?.[endpoint];
    const keyName = config?.azure ? EModelEndpoint.azureOpenAI : endpoint;
    if (!entries.has(keyName))
      entries.set(keyName, {
        endpoint,
        keyName,
        label: alternateName[endpoint] || endpoint,
        conflict: false,
      });
  }
  for (const [keyName, media] of mergeMediaUserKeys(mediaIntegrations)) {
    const previous = entries.get(keyName);
    if (!previous) {
      entries.set(keyName, {
        endpoint: keyName,
        keyName,
        label: media.label,
        conflict: media.conflict,
        keyConfiguration: media,
      });
      continue;
    }
    const config = endpointsConfig?.[previous.endpoint];
    const conflict = media.conflict || config?.keyEncoding !== media.encoding;
    const userProvideURL = media.userProvideURL || !!config?.userProvideURL;
    entries.set(keyName, {
      ...previous,
      conflict,
      ...(userProvideURL
        ? {
            keyConfiguration: {
              keyName,
              encoding: media.encoding,
              userProvideURL,
              label: previous.label,
            },
          }
        : {}),
    });
  }
  return [...entries.values()];
}

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

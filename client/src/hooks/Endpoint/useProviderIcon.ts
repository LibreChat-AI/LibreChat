import { useMemo } from 'react';
import { getEndpointField, resolveProviderId, endpointToProvider } from 'librechat-data-provider';
import type { TEndpointsConfig, EModelEndpoint, ProviderId } from 'librechat-data-provider';
import { isImageURL } from '~/utils/icons';

export interface ProviderIconResolution {
  provider: ProviderId | null;
  imageURL: string | null;
}

export interface ProviderIconParams {
  endpoint?: string | null;
  endpointsConfig?: TEndpointsConfig | null;
  iconURL?: string | null;
}

/**
 * Single source of truth for which art a given endpoint renders. Precedence, highest
 * first: an image iconURL, an iconURL naming a provider, the server resolved
 * providerId, the first-class endpoint mapping, then the endpoint name.
 */
export function resolveProviderIcon({
  endpoint,
  endpointsConfig,
  iconURL,
}: ProviderIconParams): ProviderIconResolution {
  const configured = getEndpointField(endpointsConfig, endpoint, 'iconURL');
  const candidate = iconURL || configured;

  if (isImageURL(candidate)) {
    return { provider: null, imageURL: candidate };
  }

  const declared = resolveProviderId(candidate);
  if (declared) {
    return { provider: declared, imageURL: null };
  }

  const served = getEndpointField(endpointsConfig, endpoint, 'providerId');
  if (served) {
    return { provider: served, imageURL: null };
  }

  const firstClass = endpoint ? endpointToProvider[endpoint as EModelEndpoint] : undefined;
  if (firstClass) {
    return { provider: firstClass, imageURL: null };
  }

  return { provider: resolveProviderId(endpoint), imageURL: null };
}

/** Memoized form of {@link resolveProviderIcon}, for use outside render callbacks. */
export function useProviderIcon({
  endpoint,
  endpointsConfig,
  iconURL,
}: ProviderIconParams): ProviderIconResolution {
  return useMemo(
    () => resolveProviderIcon({ endpoint, endpointsConfig, iconURL }),
    [endpoint, endpointsConfig, iconURL],
  );
}

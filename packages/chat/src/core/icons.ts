import { getEndpointField, resolveProviderId, endpointToProvider } from 'librechat-data-provider';
import type { TEndpointsConfig, EModelEndpoint, ProviderId } from 'librechat-data-provider';

/** Every image format browsers render, so a configured path is never mistaken for a provider name. */
const IMAGE_EXTENSION =
  /\.(apng|avif|bmp|cur|gif|ico|jfif|jpe?g|pjp|pjpeg|png|svg|webp)(?:[?#].*)?$/i;

/** Whether an icon URL names an image to load, rather than a provider whose art to draw. */
export function isImageURL(iconURL?: string | null): iconURL is string {
  if (!iconURL) {
    return false;
  }

  if (/^https?:\/\//i.test(iconURL) || /^data:image\/[a-z0-9.+-]+/i.test(iconURL)) {
    return true;
  }

  if (iconURL.startsWith('//')) {
    return /^\/\/[^/]/.test(iconURL);
  }

  return iconURL.startsWith('/') || IMAGE_EXTENSION.test(iconURL);
}

/**
 * The endpoint whose icon a message or conversation shows: the one its `iconURL` names when the
 * endpoints config has an endpoint by that name, otherwise its own endpoint.
 */
export function getIconEndpoint({
  endpointsConfig,
  iconURL,
  endpoint,
}: {
  endpointsConfig?: TEndpointsConfig | null;
  iconURL?: string | null;
  endpoint?: string | null;
}): string {
  return (endpointsConfig?.[iconURL ?? ''] ? (iconURL ?? endpoint) : endpoint) ?? '';
}

/** The art an endpoint draws: an image to load, or a provider's icon. */
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

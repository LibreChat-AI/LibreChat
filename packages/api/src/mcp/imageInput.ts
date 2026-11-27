import { EModelEndpoint, normalizeEndpointName } from 'librechat-data-provider';
import type { TFileConfig } from 'librechat-data-provider';
import type { Providers } from '@librechat/agents';
import type { ServerRequest } from '~/types';
import { isConfiguredProviderMediaType } from '~/files/encode/utils';

/** Image types MCP tools return as `image` content; an endpoint opts in to each one. */
const MCP_IMAGE_INPUT_CANDIDATES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** `fileConfig.endpoints` keys that other endpoints fall back to; none is an endpoint's own entry. */
const FALLBACK_ENDPOINT_KEYS = new Set<string>([
  'default',
  EModelEndpoint.custom,
  EModelEndpoint.agents,
]);

/**
 * Whether the endpoint's own `fileConfig.endpoints` entry lists `supportedMimeTypes`, looked up
 * by name as `getEndpointFileConfig` does. The merged endpoint config cannot tell: an entry
 * without its own list inherits an admin-configured `default`, `custom` or `agents` list.
 */
function declaresOwnMimeTypes(fileConfig: TFileConfig, endpoint: string): boolean {
  const endpoints = fileConfig.endpoints;
  if (!endpoints || FALLBACK_ENDPOINT_KEYS.has(endpoint)) {
    return false;
  }
  const normalized = normalizeEndpointName(endpoint);
  const ownKey =
    endpoint in endpoints
      ? endpoint
      : Object.keys(endpoints).find(
          (key) => !FALLBACK_ENDPOINT_KEYS.has(key) && normalizeEndpointName(key) === normalized,
        );
  const types = ownKey ? endpoints[ownKey]?.supportedMimeTypes : undefined;
  return Array.isArray(types) && types.length > 0;
}

/**
 * The image MIME types the request's endpoint explicitly accepts, for MCP tool image results.
 *
 * Providers on the parser's recognized list always receive tool images as image input. Any
 * other endpoint, such as an OpenAI-compatible custom endpoint, receives them only for the types
 * an admin listed in that endpoint's own `fileConfig.endpoints.<name>.supportedMimeTypes`. A
 * list it inherits (the built-in default, or an admin's `default`, `custom` or `agents` entry)
 * never counts, so a text-only model behind a custom endpoint keeps receiving no image input.
 */
export function resolveMCPImageInputMimeTypes(
  req: Pick<ServerRequest, 'config'> | undefined,
  endpoint: string | undefined,
): string[] {
  const fileConfig = req?.config?.fileConfig;
  if (!fileConfig || !endpoint || !declaresOwnMimeTypes(fileConfig, endpoint)) {
    return [];
  }
  return MCP_IMAGE_INPUT_CANDIDATES.filter((mimeType) =>
    isConfiguredProviderMediaType(
      req as ServerRequest,
      { provider: endpoint as Providers, endpoint },
      mimeType,
    ),
  );
}

import type { Providers } from '@librechat/agents';
import type { ServerRequest } from '~/types';
import { isConfiguredProviderMediaType } from '~/files/encode/utils';

/** Image types MCP tools return as `image` content; an endpoint opts in to each one. */
const MCP_IMAGE_INPUT_CANDIDATES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * The image MIME types the request's endpoint explicitly accepts, for MCP tool image results.
 *
 * Providers on the parser's recognized list always receive tool images as image input. Any
 * other endpoint, such as an OpenAI-compatible custom endpoint, receives them only for the types
 * an admin listed in `fileConfig.endpoints.<name>.supportedMimeTypes`, the same opt-in that
 * uploaded video and audio use. The inherited default list never counts, so a text-only model
 * behind a custom endpoint keeps receiving no image input.
 */
export function resolveMCPImageInputMimeTypes(
  req: Pick<ServerRequest, 'config'> | undefined,
  endpoint: string | undefined,
): string[] {
  if (!req?.config?.fileConfig || !endpoint) {
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

import { digestMCPAuthorityValue } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { ParsedServerConfig } from './types';
import type { RequestBody } from '~/types';
import { processMCPEnv, isPluginSourced } from '~/utils/env';
import { getAdminApiKeyHeader } from './headers';

export interface MCPToolReviewAuthorityInput {
  serverName: string;
  config: ParsedServerConfig | undefined;
  user?: Partial<Pick<IUser, 'id' | 'tenantId' | 'username' | 'email' | 'name' | 'openidId'>>;
  body?: RequestBody;
  customUserVars?: Record<string, string>;
}

/** Renewable bearer bytes are not authority; routing, principal and provider configuration are. */
export function buildMCPToolReviewAuthority({
  serverName,
  config,
  user,
  body,
  customUserVars,
}: MCPToolReviewAuthorityInput): string | undefined {
  if (!config) return undefined;
  const declaredHeaders = {
    headers: 'headers' in config ? config.headers : undefined,
    oauth_headers: 'oauth_headers' in config ? config.oauth_headers : undefined,
  };
  const renewableMarker =
    /\{\{LIBRECHAT_(?:OPENID|GRAPH)_(?:ACCESS|ID)_TOKEN\}\}|\$\{LIBRECHAT_(?:OPENID|GRAPH)_(?:ACCESS|ID)_TOKEN\}/g;
  const resolutionInput = { ...config } as ParsedServerConfig & {
    headers?: Record<string, string>;
    oauth_headers?: Record<string, string>;
  };
  for (const field of ['headers', 'oauth_headers'] as const) {
    const headers = declaredHeaders[field];
    if (headers)
      resolutionInput[field] = Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
          name,
          value.replace(renewableMarker, 'review-only-renewable-bearer'),
        ]),
      );
  }
  const resolved = processMCPEnv({ options: resolutionInput, user, body, customUserVars });
  const projected = { ...resolved } as typeof resolved & {
    headers?: Record<string, string>;
    oauth_headers?: Record<string, string>;
  };
  const injectedAuth = getAdminApiKeyHeader(config.apiKey);
  for (const field of ['headers', 'oauth_headers'] as const) {
    const declared = declaredHeaders[field];
    const values = projected[field];
    if (!declared || !values) continue;
    for (const [name, value] of Object.entries(declared)) {
      if (
        /LIBRECHAT_(?:OPENID|GRAPH)_(?:ACCESS|ID)_TOKEN/.test(value) &&
        values[name]?.includes('review-only-renewable-bearer') &&
        !(field === 'headers' && injectedAuth?.name.toLowerCase() === name.toLowerCase())
      )
        values[name] = value;
    }
  }
  const target = {
    url: 'url' in projected ? projected.url : undefined,
    command: 'command' in projected ? projected.command : undefined,
    args: 'args' in projected ? projected.args : undefined,
  };
  if (!isPluginSourced(config) && /\{\{[^{}]+\}\}|\$\{[^{}]+\}/.test(JSON.stringify(target)))
    return undefined;
  return digestMCPAuthorityValue({
    serverName,
    principal: { id: user?.id, tenantId: user?.tenantId, openidId: user?.openidId },
    declared: config,
    resolved: projected,
  });
}

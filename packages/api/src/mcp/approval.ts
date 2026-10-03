import { digestMCPAuthorityValue } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { ParsedServerConfig } from './types';
import type { RequestBody } from '~/types';
import { processMCPEnv, isPluginSourced } from '~/utils/env';
import { applyRequestHeaders } from './utils';

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
  config = applyRequestHeaders(config);
  const declaredHeaders = {
    headers: 'headers' in config ? config.headers : undefined,
    oauth_headers: 'oauth_headers' in config ? config.oauth_headers : undefined,
  };
  const renewableMarker =
    /\{\{LIBRECHAT_(?:OPENID_(?:(?:ACCESS|ID)_)?TOKEN|GRAPH_ACCESS_TOKEN)\}\}/g;
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

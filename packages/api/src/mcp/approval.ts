import { digestMCPAuthorityValue } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { ParsedServerConfig } from './types';
import type { RequestBody } from '~/types';
import { processMCPEnv, isPluginSourced } from '~/utils/env';
import { applyRequestHeaders } from './utils';

export interface MCPToolReviewAuthorityInput {
  serverName: string;
  config: ParsedServerConfig | undefined;
  user?: Partial<
    Pick<
      IUser,
      | 'id'
      | 'tenantId'
      | 'username'
      | 'email'
      | 'name'
      | 'openidId'
      | 'provider'
      | 'openidTokens'
      | 'federatedTokens'
    >
  >;
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
  const renewableMarker =
    /\{\{LIBRECHAT_(?:OPENID_(?:(?:ACCESS|ID)_)?TOKEN|GRAPH_ACCESS_TOKEN)\}\}/g;
  const mask = (value: string): string =>
    value.replace(renewableMarker, 'review-only-renewable-bearer');
  const maskFields = (fields: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, mask(value)]));
  const resolutionInput = structuredClone(config);
  // Mask only renewable fragments; processMCPEnv still resolves routing and principal fields.
  if ('env' in resolutionInput && resolutionInput.env)
    resolutionInput.env = maskFields(resolutionInput.env);
  if ('args' in resolutionInput && resolutionInput.args)
    resolutionInput.args = resolutionInput.args.map(mask);
  if ('headers' in resolutionInput && resolutionInput.headers)
    resolutionInput.headers = maskFields(resolutionInput.headers);
  if ('oauth_headers' in resolutionInput && resolutionInput.oauth_headers)
    resolutionInput.oauth_headers = maskFields(resolutionInput.oauth_headers);
  if ('url' in resolutionInput && resolutionInput.url)
    resolutionInput.url = mask(resolutionInput.url);
  if (resolutionInput.apiKey?.key) resolutionInput.apiKey.key = mask(resolutionInput.apiKey.key);
  if (resolutionInput.oauth) {
    resolutionInput.oauth = Object.fromEntries(
      Object.entries(resolutionInput.oauth).map(([key, value]) => [
        key,
        typeof value === 'string' ? mask(value) : value,
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

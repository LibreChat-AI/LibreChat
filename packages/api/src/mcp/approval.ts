import { digestMCPAuthorityValue } from '@librechat/data-schemas';
import type { ToolApprovalAuthKind } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { ParsedServerConfig } from './types';
import type { RequestBody } from '~/types';
import { isOAuthServer, hasRuntimeUrlPlaceholders } from './utils';
import { isDirectOpenIDBearerRecoveryEnabled } from './openid';
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

/** Match the configured factory path, not the existence of old stored tokens. */
export function getMCPToolApprovalAuthKind(
  config: ParsedServerConfig | undefined,
): ToolApprovalAuthKind | undefined {
  if (!config) return undefined;
  const effective = applyRequestHeaders(config);
  if (effective.obo || isDirectOpenIDBearerRecoveryEnabled(effective)) return 'other';
  if (isOAuthServer(effective)) return 'oauth';
  // UserConnectionManager detects auth only after a trusted runtime URL resolves.
  if (
    effective.requiresOAuth == null &&
    effective.apiKey == null &&
    hasRuntimeUrlPlaceholders(effective)
  )
    return undefined;
  return 'other';
}

/** Registry timestamps and inspection summaries do not change executable authority. */
export function projectMCPApprovalAuthority(config: ParsedServerConfig): ParsedServerConfig {
  const {
    updatedAt: _updatedAt,
    initDuration: _duration,
    capabilities: _capabilities,
    tools: _tools,
    toolFunctions: _functions,
    resolvedInstructions: _instructions,
    inspectionFailed: _failed,
    ...authority
  } = config;
  return authority;
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
  config = projectMCPApprovalAuthority(applyRequestHeaders(config));
  const renewableMarker =
    /\{\{LIBRECHAT_(?:OPENID_(?:(?:ACCESS|ID)_)?TOKEN|GRAPH_ACCESS_TOKEN)\}\}/g;
  const mask = (value: string): string =>
    value.replace(renewableMarker, 'review-only-renewable-bearer');
  const resolved = processMCPEnv({
    options: config,
    user,
    body,
    customUserVars,
    beforeCredentialResolution: mask,
  });
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

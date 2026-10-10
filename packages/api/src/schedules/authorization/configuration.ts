import { createHash } from 'node:crypto';
import type { ScheduledMCPResourceBinding } from 'librechat-data-provider';
import type { ParsedServerConfig } from '~/mcp/types';
import { processMCPEnv, isPluginSourced } from '~/utils/env';
import { ScheduleMCPConsentError } from './service';

type IdentityValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | IdentityValue[]
  | { [key: string]: IdentityValue };

function canonical(value: IdentityValue): IdentityValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value == null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function hasTemplate(value: IdentityValue): boolean {
  if (typeof value === 'string') return value.includes('{{');
  if (Array.isArray(value)) return value.some(hasTemplate);
  return value != null && typeof value === 'object' && Object.values(value).some(hasTemplate);
}

/** Live provider credentials may vary; unbound routing variables may not. */
function hasRoutingTemplate(headers?: Record<string, string>): boolean {
  return Object.entries(headers ?? {}).some(([name, value]) => {
    const routing =
      name.toLowerCase() === 'authorization'
        ? value.replace(
            /\{\{LIBRECHAT_(?:OPENID_(?:ACCESS_TOKEN|ID_TOKEN|TOKEN)|GRAPH_ACCESS_TOKEN)\}\}/g,
            '',
          )
        : value;
    return hasTemplate(name) || hasTemplate(routing);
  });
}

/** Binds effective routing and trust without retaining tokens or rotating client/API secrets. */
export function getScheduledMCPConfigurationRevision(
  config: ParsedServerConfig,
  binding: ScheduledMCPResourceBinding,
): string {
  if (config.type !== 'sse' && config.type !== 'http' && config.type !== 'streamable-http')
    throw new ScheduleMCPConsentError('consent_unavailable');
  const declared = {
    type: config.type,
    url: config.url,
    dbId: config.dbId,
    source: config.source,
    headers: config.headers,
    requestHeaders: config.requestHeaders,
    proxy: config.proxy,
    requiresOAuth: config.requiresOAuth,
    oauth: config.oauth && { ...config.oauth, client_secret: undefined },
    oauth_headers: config.oauth_headers,
    obo: config.obo,
    apiKey: config.apiKey && { ...config.apiKey, key: undefined },
  };
  const runtime = processMCPEnv({ options: declared });
  if (runtime.type !== 'sse' && runtime.type !== 'http' && runtime.type !== 'streamable-http')
    throw new ScheduleMCPConsentError('consent_unavailable');
  const request = processMCPEnv({ options: { ...declared, headers: config.requestHeaders } });
  const requestHeaders = 'headers' in request ? request.headers : undefined;
  if (
    !isPluginSourced(config) &&
    (hasTemplate([runtime.url, runtime.proxy, runtime.oauth, runtime.obo]) ||
      hasRoutingTemplate(runtime.headers) ||
      hasRoutingTemplate(requestHeaders) ||
      hasRoutingTemplate(runtime.oauth_headers))
  )
    throw new ScheduleMCPConsentError('consent_unavailable');
  // Do not reparse through transforming schemas: plugin/DB URLs must remain literal.
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonical([
          { ...runtime, requestHeaders },
          config.dbId ?? null,
          config.source ?? null,
          config.author ?? null,
          binding.url,
          binding.credentialMode,
          binding.issuer,
          binding.audience,
          [...new Set(binding.scopes)].sort(),
        ]),
      ),
    )
    .digest('hex');
}

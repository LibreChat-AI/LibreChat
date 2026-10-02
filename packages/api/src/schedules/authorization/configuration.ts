import { createHash } from 'node:crypto';
import type { ScheduledMCPResourceBinding } from 'librechat-data-provider';
import type { ParsedServerConfig } from '~/mcp/types';
import { getMCPAppToolsPublicationGeneration } from '~/mcp/toolsChanged';
import { ScheduleMCPConsentError } from './service';

/** Binds configured routing and trust, not provider tokens or rotating client/API secrets. */
export function getScheduledMCPConfigurationRevision(
  config: ParsedServerConfig,
  binding: ScheduledMCPResourceBinding,
): string {
  if (config.type !== 'sse' && config.type !== 'http' && config.type !== 'streamable-http')
    throw new ScheduleMCPConsentError('consent_unavailable');
  const generation = getMCPAppToolsPublicationGeneration({
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
  });
  return createHash('sha256')
    .update(
      JSON.stringify([
        generation,
        config.dbId ?? null,
        config.source ?? null,
        config.author ?? null,
        binding.url,
        binding.credentialMode,
        binding.issuer,
        binding.audience,
        [...new Set(binding.scopes)].sort(),
      ]),
    )
    .digest('hex');
}

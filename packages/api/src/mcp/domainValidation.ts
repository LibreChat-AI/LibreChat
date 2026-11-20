import type { ParsedServerConfig } from '~/mcp/types';

/**
 * Fields an MCP domain decision never reads, dropped before placeholder
 * resolution so the decision cannot depend on a credential it does not inspect.
 *
 * `isMCPDomainAllowed` decides from `url` alone, but `processMCPEnv` resolves
 * every field it is handed, and `{{LIBRECHAT_OPENID_ACCESS_TOKEN}}` (or its
 * `{{LIBRECHAT_OPENID_TOKEN}}` alias) in any of them raises
 * `OpenIDReauthRequiredError` when the request-time user snapshot carries a stale
 * access token — the snapshot `openIdJwtStrategy` populates from
 * `req.session.openidTokens` without refreshing. A header the decision never
 * looks at could therefore fail a server whose bearer the connection path
 * refreshes a moment later through `resolveDirectOpenIDBearerConfig`, and the
 * tool was dropped from the agent's toolset instead of being loaded.
 *
 * `url` is deliberately absent from this list: it decides which host is
 * contacted, so an unresolvable credential placeholder there must keep failing
 * closed.
 */
const UNREAD_BY_DOMAIN_VALIDATION = [
  'apiKey',
  'args',
  'env',
  'headers',
  'oauth',
  'oauth_headers',
] as const;

/**
 * Narrows a server config to what a domain check reads, so resolving it needs no
 * live credential. Every other field is preserved, including the `source` and
 * `dbId` that decide which placeholders `processMCPEnv` resolves at all, and the
 * presence or absence of `url` that `isMCPDomainAllowed` fails closed on.
 *
 * Callers pass the result to `processMCPEnv` and then to `isMCPDomainAllowed`.
 * The argument is never mutated, so a direct-bearer server keeps its placeholder
 * for the connection path that knows how to refresh it.
 */
export function buildMCPDomainValidationConfig(config: ParsedServerConfig): ParsedServerConfig {
  const validationConfig: Record<string, unknown> = { ...(config as Record<string, unknown>) };
  for (const field of UNREAD_BY_DOMAIN_VALIDATION) {
    delete validationConfig[field];
  }
  return validationConfig as unknown as ParsedServerConfig;
}

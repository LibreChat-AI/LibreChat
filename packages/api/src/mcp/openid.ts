import { extractEnvVariable } from 'librechat-data-provider';
import type { UpstreamTokenProvider } from './oauth/obo';
import type { MCPOptions } from './types';
import { isRetryableOboExchangeError } from './oauth/obo';
import { MCPAuthenticationRefreshError } from './errors';
import { OpenIDReauthRequiredError } from '~/utils/oidc';
import { getAdminApiKeyHeader } from './headers';
import { isAbortError } from '~/utils/errors';

const OPENID_ACCESS_TOKEN_PATTERN = /\{\{LIBRECHAT_OPENID_(?:ACCESS_TOKEN|TOKEN)\}\}/;
const OPENID_ACCESS_TOKEN_REPLACEMENT_PATTERN = /\{\{LIBRECHAT_OPENID_(?:ACCESS_TOKEN|TOKEN)\}\}/g;
/** Request-local snapshots carry the opaque token without serializing it as new config metadata. */
const resolvedAccessTokens = new WeakMap<MCPOptions, string>();

type DirectBearerConfig = MCPOptions & {
  dbId?: string;
  source?: 'yaml' | 'config' | 'user' | 'plugin';
};

function getAuthorizationHeader(
  config: DirectBearerConfig,
): { name: string; value: string } | null {
  if (!('headers' in config) || !config.headers) {
    return null;
  }

  const entry = Object.entries(config.headers).find(
    ([name]) => name.toLowerCase() === 'authorization',
  );
  return entry ? { name: entry[0], value: entry[1] } : null;
}

/** Expands an operator-owned environment indirection before looking for the OpenID placeholder. */
function getAuthorizationTemplateValue(value: string): string {
  return extractEnvVariable(value);
}

function apiKeyOwnsAuthorization(config: DirectBearerConfig): boolean {
  return getAdminApiKeyHeader(config.apiKey)?.name.toLowerCase() === 'authorization';
}

function resolveAccessTokenPlaceholders(
  config: DirectBearerConfig,
  token: string,
): DirectBearerConfig {
  const resolve = (value: string) => {
    const template = extractEnvVariable(value);
    return OPENID_ACCESS_TOKEN_PATTERN.test(template)
      ? template.replace(OPENID_ACCESS_TOKEN_REPLACEMENT_PATTERN, () => token)
      : value;
  };
  const resolveMap = (values: Record<string, string>) =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, resolve(value)]));
  const resolved = { ...config };
  if ('headers' in resolved && resolved.headers) {
    resolved.headers = resolveMap(resolved.headers);
  }
  if ('oauth_headers' in resolved && resolved.oauth_headers) {
    resolved.oauth_headers = resolveMap(resolved.oauth_headers);
  }
  if ('url' in resolved) {
    resolved.url = resolve(resolved.url);
  }
  if ('env' in resolved && resolved.env) {
    resolved.env = resolveMap(resolved.env);
  }
  if ('args' in resolved && resolved.args) {
    resolved.args = resolved.args.map(resolve);
  }
  if (resolved.oauth) {
    resolved.oauth = Object.fromEntries(
      Object.entries(resolved.oauth).map(([key, value]) => [
        key,
        typeof value === 'string' ? resolve(value) : value,
      ]),
    );
  }
  resolvedAccessTokens.set(resolved, token);
  return resolved;
}

/** Explicit OAuth/OBO/API keys own Authorization. Remove only the lower-priority OpenID template
 * before generic runtime expansion can demand or inject the upstream bearer directly. */
function removeShadowedOpenIDAuthorization(config: DirectBearerConfig): DirectBearerConfig {
  const authorization = getAuthorizationHeader(config);
  if (
    authorization == null ||
    !OPENID_ACCESS_TOKEN_PATTERN.test(getAuthorizationTemplateValue(authorization.value)) ||
    !('headers' in config)
  ) {
    return config;
  }

  const headers = { ...config.headers };
  delete headers[authorization.name];
  return { ...config, headers };
}

/** Whether a trusted operator config explicitly routes its OpenID bearer to this server. */
export function isDirectOpenIDBearerRecoveryEnabled(config: DirectBearerConfig): boolean {
  /** Explicit credential modes take precedence over the legacy passthrough placeholder. */
  if (
    config.obo != null ||
    apiKeyOwnsAuthorization(config) ||
    (config.oauth != null && config.requiresOAuth !== false) ||
    config.dbId != null
  ) {
    return false;
  }
  if (config.source !== 'yaml' && config.source !== 'config') {
    return false;
  }
  const authorization = getAuthorizationHeader(config);
  return (
    authorization != null &&
    OPENID_ACCESS_TOKEN_PATTERN.test(getAuthorizationTemplateValue(authorization.value))
  );
}

/** Whether a trusted direct-bearer config still needs its live placeholder resolved. */
export function usesDirectOpenIDBearerRecovery(config: DirectBearerConfig): boolean {
  return isDirectOpenIDBearerRecoveryEnabled(config);
}

/** Resolves the live bearer before a connection or request reaches the MCP transport. */
export async function resolveDirectOpenIDBearerConfig({
  config,
  upstreamTokenProvider,
  forceRefresh = false,
  resolvedConfig,
  signal,
}: {
  config: DirectBearerConfig;
  upstreamTokenProvider?: UpstreamTokenProvider;
  forceRefresh?: boolean;
  resolvedConfig?: MCPOptions;
  signal?: AbortSignal;
}): Promise<DirectBearerConfig> {
  signal?.throwIfAborted();
  if (
    config.obo != null ||
    apiKeyOwnsAuthorization(config) ||
    (config.oauth != null && config.requiresOAuth !== false)
  ) {
    return removeShadowedOpenIDAuthorization(config);
  }
  if (!usesDirectOpenIDBearerRecovery(config)) {
    return config;
  }
  const authorization = getAuthorizationHeader(config);
  const resolvedToken = resolvedConfig && resolvedAccessTokens.get(resolvedConfig);
  if (!forceRefresh && resolvedToken != null) {
    return resolveAccessTokenPlaceholders(config, resolvedToken);
  }
  const resolvedAuthorization = resolvedConfig && getAuthorizationHeader(resolvedConfig);
  if (!forceRefresh && authorization && resolvedAuthorization && 'headers' in config) {
    return {
      ...config,
      headers: { ...config.headers, [authorization.name]: resolvedAuthorization.value },
    };
  }
  if (!upstreamTokenProvider) {
    /** Keep the established `processMCPEnv` path available to API consumers that only
     * provide the verified request user. Recovery still requires a live session: once
     * the upstream rejects that bearer, a forced resolution must fail closed rather
     * than reconnecting with the same stale credential. */
    if (!forceRefresh) {
      return config;
    }
    throw new OpenIDReauthRequiredError(
      'A live OpenID session is required to recover this MCP bearer credential.',
    );
  }

  let tokens;
  try {
    tokens = await upstreamTokenProvider({ forceRefresh, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    if (isAbortError(error)) {
      throw error;
    }
    if (isRetryableOboExchangeError(error)) {
      throw new MCPAuthenticationRefreshError(error);
    }
    const reauthError = new OpenIDReauthRequiredError(
      'The OpenID session could not refresh the MCP bearer credential. Please sign in again.',
    );
    reauthError.cause = error;
    throw reauthError;
  }
  if (!tokens?.access_token) {
    /** A verified bearer-authenticated request has no Express session to refresh. Its
     * strategy-populated user token remains the authoritative non-forced fallback. */
    if (!forceRefresh) {
      return config;
    }
    throw new OpenIDReauthRequiredError(
      'The OpenID session has no usable MCP bearer credential. Please sign in again.',
    );
  }

  if (!authorization || !('headers' in config)) {
    return config;
  }
  return resolveAccessTokenPlaceholders(config, tokens.access_token);
}

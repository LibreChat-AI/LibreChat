import { createHash } from 'crypto';
import type { MCPOptions } from '~/mcp/types';
import { MCPApiKeyReentryRequiredError } from '~/mcp/errors';

function getUrl(config: MCPOptions): string | undefined {
  return 'url' in config ? config.url : undefined;
}

function getProxy(config: MCPOptions): string | undefined {
  return 'proxy' in config ? config.proxy : undefined;
}

function normalizeUrl(value?: string): string | undefined {
  if (!value) {
    return value;
  }

  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}

function normalizeTransport(type: MCPOptions['type']): string {
  return type === 'http' ? 'streamable-http' : type;
}

function normalizeCustomHeader(apiKey: MCPOptions['apiKey']): string | undefined {
  if (apiKey?.authorization_type !== 'custom') {
    return undefined;
  }
  return (apiKey.custom_header || 'X-Api-Key').toLowerCase();
}

function apiKeyBinding(config: MCPOptions): Record<string, string | undefined> {
  return {
    url: normalizeUrl(getUrl(config)),
    type: normalizeTransport(config.type),
    proxy: normalizeUrl(getProxy(config)),
    'apiKey.authorization_type': config.apiKey?.authorization_type,
    'apiKey.custom_header': normalizeCustomHeader(config.apiKey),
  };
}

/** Returns fields that would move an omitted, stored admin key to a new request boundary. */
export function getChangedApiKeyBindingFields(
  existingConfig: MCPOptions,
  updatedConfig: MCPOptions,
): string[] {
  const preservesStoredKey =
    existingConfig.apiKey?.source === 'admin' &&
    !!existingConfig.apiKey.key &&
    updatedConfig.apiKey?.source === 'admin' &&
    !updatedConfig.apiKey.key;

  if (!preservesStoredKey) {
    return [];
  }

  const existing = apiKeyBinding(existingConfig);
  const updated = apiKeyBinding(updatedConfig);
  return Object.keys(existing).filter((field) => existing[field] !== updated[field]);
}

function userApiKeyBinding(config: MCPOptions): string {
  return JSON.stringify([
    apiKeyBinding(config),
    normalizeUrl(config.oauth?.authorization_url),
    normalizeUrl(config.oauth?.token_url),
    normalizeUrl(config.oauth?.redirect_uri),
    normalizeUrl(config.oauth?.revocation_endpoint),
    config.oauth?.client_id,
  ]);
}

/** Uses the existing auth-field storage to bind each user's key to the request destination.
 *  Legacy keys stay usable only while their original boundary is unchanged. */
export function getUserApiKeyVariable(config: MCPOptions, existingConfig?: MCPOptions): string {
  const binding = userApiKeyBinding(config);
  if (
    existingConfig?.apiKey?.source === 'user' &&
    existingConfig.customUserVars?.MCP_API_KEY &&
    binding === userApiKeyBinding(existingConfig)
  ) {
    return 'MCP_API_KEY';
  }
  return `MCP_API_KEY_${createHash('sha256').update(binding).digest('hex')}`;
}

/** Requires a replacement key before a stored admin credential can cross request boundaries. */
export function requireApiKeyReentryForRebinding(
  existingConfig: MCPOptions,
  updatedConfig: MCPOptions,
): void {
  const changedFields = getChangedApiKeyBindingFields(existingConfig, updatedConfig);
  if (changedFields.length > 0) {
    throw new MCPApiKeyReentryRequiredError(changedFields);
  }
}

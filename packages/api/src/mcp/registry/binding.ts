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

/** Returns fields that would move an omitted, stored admin key to a new request boundary. */
export function getChangedApiKeyBindingFields(
  existingConfig: MCPOptions,
  updatedConfig: MCPOptions,
): string[] {
  const existingApiKey = existingConfig.apiKey;
  const updatedApiKey = updatedConfig.apiKey;
  const preservesStoredKey =
    existingApiKey?.source === 'admin' &&
    !!existingApiKey.key &&
    updatedApiKey?.source === 'admin' &&
    !updatedApiKey.key;

  if (!preservesStoredKey) {
    return [];
  }

  const fields = [
    ['url', normalizeUrl(getUrl(existingConfig)), normalizeUrl(getUrl(updatedConfig))],
    ['type', normalizeTransport(existingConfig.type), normalizeTransport(updatedConfig.type)],
    ['proxy', normalizeUrl(getProxy(existingConfig)), normalizeUrl(getProxy(updatedConfig))],
    [
      'apiKey.authorization_type',
      existingApiKey.authorization_type,
      updatedApiKey.authorization_type,
    ],
    [
      'apiKey.custom_header',
      normalizeCustomHeader(existingApiKey),
      normalizeCustomHeader(updatedApiKey),
    ],
  ] as const;

  return fields.filter(([, existing, updated]) => existing !== updated).map(([field]) => field);
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

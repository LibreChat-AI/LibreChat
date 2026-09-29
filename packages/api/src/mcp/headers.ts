import type { MCPOptions } from 'librechat-data-provider';

type ApiKeyConfig = Partial<NonNullable<MCPOptions['apiKey']>> | null | undefined;

function getApiKeyHeaderName(apiKey: ApiKeyConfig): string {
  return apiKey?.authorization_type === 'custom'
    ? apiKey.custom_header || 'X-Api-Key'
    : 'Authorization';
}

/** The header injected by an operator-provided API key, before placeholder resolution. */
export function getAdminApiKeyHeader(
  apiKey: ApiKeyConfig,
): { name: string; value: string } | undefined {
  if (apiKey?.source !== 'admin' || !apiKey.key) {
    return;
  }
  const { key, authorization_type } = apiKey;
  const name = getApiKeyHeaderName(apiKey);
  const prefixes = { basic: 'Basic ', bearer: 'Bearer ', custom: '' };
  const prefix = prefixes[authorization_type ?? 'custom'];
  return { name, value: `${prefix}${key}` };
}

/** A shadowed catalog credential must not be injected or required by a chat connection. */
export function isApiKeyHeaderOverridden(
  apiKey: ApiKeyConfig,
  requestHeaders?: Record<string, string | undefined>,
): boolean {
  const injected = apiKey?.source === 'user' || getAdminApiKeyHeader(apiKey) != null;
  return (
    injected &&
    requestHeaders != null &&
    Object.keys(requestHeaders).some(
      (name) => name.toLowerCase() === getApiKeyHeaderName(apiKey).toLowerCase(),
    )
  );
}

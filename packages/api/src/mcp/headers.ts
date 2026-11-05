import type { MCPOptions } from 'librechat-data-provider';

type ApiKeyConfig = Partial<NonNullable<MCPOptions['apiKey']>> | null | undefined;

/** Recognizes only server-generated API key fields, not similarly named explicit variables. */
export function isGeneratedUserApiKeyVariable(name: string): boolean {
  return /^MCP_API_KEY(?:_[a-f0-9]{64})?$/.test(name);
}

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

/** Reads the static `headers` map a remote transport config may carry. */
export function getConfigHeaders(config?: MCPOptions | null): Record<string, string> | undefined {
  return (config as { headers?: Record<string, string> } | null | undefined)?.headers ?? undefined;
}

const GENERATED_API_KEY_PLACEHOLDER = /\{\{MCP_API_KEY(?:_[a-f0-9]{64})?\}\}/;

/**
 * Names of the user-defined custom headers, never their values, for API responses. The header
 * generated for a per-user API key is excluded because the API key settings own it.
 */
export function getHeaderNames(config: MCPOptions): string[] | undefined {
  const headers = getConfigHeaders(config);
  if (!headers) {
    return undefined;
  }
  const isUserApiKey = config.apiKey?.source === 'user';
  const names = Object.keys(headers).filter(
    (name) => !(isUserApiKey && GENERATED_API_KEY_PLACEHOLDER.test(headers[name])),
  );
  return names.length > 0 ? names : undefined;
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

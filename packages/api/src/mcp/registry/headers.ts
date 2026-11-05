import { logger, encryptV2, decryptV2 } from '@librechat/data-schemas';
import type { MCPOptions } from 'librechat-data-provider';
import type { CredentialBindingConfig } from '~/mcp/registry/binding';
import type { ParsedServerConfig } from '~/mcp/types';
import { MCPHeadersReentryRequiredError } from '~/mcp/errors';
import { diffApiKeyBinding } from '~/mcp/registry/binding';
import { getConfigHeaders } from '~/mcp/headers';

type HeaderMap = Record<string, string>;

/**
 * Marks a stored header value as `encryptV2` ciphertext. Values without it are legacy plaintext
 * rows written before header encryption; they pass through on read and are encrypted on the next
 * save, so a plaintext value that happens to look like `iv:ciphertext` is never fed to decryption.
 */
export const ENCRYPTED_HEADER_PREFIX = 'enc:v2:';

/**
 * Encrypts every header value for storage. Callers pass plaintext only (submitted values, or
 * retained values already decrypted), so a submitted value that merely starts with the prefix is
 * still encrypted. Throws so a plaintext secret is never persisted.
 */
export async function encryptHeaderValues(headers: HeaderMap): Promise<HeaderMap> {
  const entries = await Promise.all(
    Object.entries(headers).map(async ([name, value]): Promise<[string, string]> => {
      if (value === '') {
        return [name, value];
      }
      return [name, `${ENCRYPTED_HEADER_PREFIX}${await encryptV2(value)}`];
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Decrypts stored header values. A value that fails to decrypt is dropped rather than sent
 * upstream as ciphertext; legacy plaintext values are returned unchanged.
 */
export async function decryptHeaderValues(headers: HeaderMap): Promise<HeaderMap> {
  const entries = await Promise.all(
    Object.entries(headers).map(async ([name, value]): Promise<[string, string] | null> => {
      if (!value.startsWith(ENCRYPTED_HEADER_PREFIX)) {
        return [name, value];
      }
      try {
        return [name, await decryptV2(value.slice(ENCRYPTED_HEADER_PREFIX.length))];
      } catch (error) {
        logger.warn(
          `[MCP registry/headers] Failed to decrypt header "${name}", dropping it from the config`,
          error,
        );
        return null;
      }
    }),
  );
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => entry != null));
}

function findStoredValue(stored: HeaderMap, name: string): string | undefined {
  const lower = name.toLowerCase();
  const match = Object.keys(stored).find((key) => key.toLowerCase() === lower);
  return match != null ? stored[match] : undefined;
}

/** True when a submitted `headers` map asks to keep at least one stored value. */
export function hasBlankHeaderValue(config?: ParsedServerConfig | null): boolean {
  const headers = getConfigHeaders(config);
  return headers != null && Object.values(headers).some((value) => value === '');
}

/**
 * Applies "leave blank to keep" to custom header values on update: a submitted header with an
 * empty value keeps the value already stored under the same (case-insensitive) name; with nothing
 * stored it stays empty, as before. Headers the update omits are dropped. Returns the merged map
 * and the names whose stored value was retained.
 */
export function mergeRetainedHeaderValues(
  submitted: HeaderMap | undefined,
  stored: HeaderMap | undefined,
): { headers: HeaderMap | undefined; retained: string[] } {
  if (!submitted) {
    return { headers: submitted, retained: [] };
  }
  const headers: HeaderMap = {};
  const retained: string[] = [];
  for (const [name, value] of Object.entries(submitted)) {
    if (value !== '') {
      headers[name] = value;
      continue;
    }
    const storedValue = stored ? findStoredValue(stored, name) : undefined;
    if (storedValue != null && storedValue !== '') {
      headers[name] = storedValue;
      retained.push(name);
      continue;
    }
    headers[name] = value;
  }
  return { headers, retained };
}

/**
 * The submitted config with blank header values resolved to their stored values, without the
 * request-boundary check, for comparisons such as the OBO lockdown. Never persist its result.
 */
export function withRetainedHeaderValues<T extends MCPOptions>(
  config: T,
  existingConfig?: MCPOptions | null,
): T {
  const submitted = getConfigHeaders(config);
  if (!submitted) {
    return config;
  }
  const { headers } = mergeRetainedHeaderValues(submitted, getConfigHeaders(existingConfig));
  return { ...config, headers } as T;
}

/**
 * Retains blank-submitted header values from the stored config, refusing when the update would
 * send those retained values to a different `url`, `type` or `proxy` than they were saved for.
 */
export function retainStoredHeaderValues<T extends ParsedServerConfig>(
  config: T,
  existingConfig?: ParsedServerConfig | null,
): T {
  const submitted = getConfigHeaders(config);
  if (!submitted) {
    return config;
  }
  const { headers, retained } = mergeRetainedHeaderValues(
    submitted,
    getConfigHeaders(existingConfig),
  );
  if (retained.length > 0 && existingConfig) {
    const changed = diffApiKeyBinding(requestBoundary(existingConfig), requestBoundary(config));
    if (changed.length > 0) {
      throw new MCPHeadersReentryRequiredError(changed);
    }
  }
  return { ...config, headers } as T;
}

/** Where header values are sent; API key fields are compared separately by their own guard. */
function requestBoundary(config: ParsedServerConfig): CredentialBindingConfig {
  const { url, proxy } = config as { url?: string; proxy?: string };
  return { type: config.type, url, proxy };
}

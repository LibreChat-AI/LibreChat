const MASKED_VALUE = '***MASKED***';
const SAFE_OPENID_HEADER_VALUES = new Set(['content-length', 'content-type']);

function isSensitiveFieldName(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalized === 'code' ||
    normalized.includes('authorization') ||
    normalized.includes('assertion') ||
    normalized.includes('clientid') ||
    normalized.includes('connectionstring') ||
    normalized.includes('cookie') ||
    normalized.includes('credential') ||
    normalized.includes('password') ||
    normalized.includes('signature') ||
    normalized.includes('secret') ||
    normalized.includes('token') ||
    normalized.includes('verifier') ||
    normalized.includes('apikey')
  );
}

/**
 * Helper function to safely log sensitive data when debug mode is enabled
 * @param obj - Object to stringify
 * @param maxLength - Maximum length of the stringified output
 * @returns Stringified object with sensitive data masked
 */
export function safeStringify(obj: unknown, maxLength = 1000): string {
  try {
    const str = JSON.stringify(obj, (key, value) => {
      if (isSensitiveFieldName(key)) {
        return MASKED_VALUE;
      }
      return value;
    });

    const serialized = str ?? '[Unserializable value]';
    if (serialized.length > maxLength) {
      return `${serialized.substring(0, maxLength)}... (truncated)`;
    }
    return serialized;
  } catch {
    return '[Error stringifying object]';
  }
}

/**
 * Describes an OpenID request body without serializing any values. OAuth form
 * bodies routinely contain authorization codes, refresh tokens, PKCE verifiers,
 * and client secrets, so even partially masked values are unsafe to log.
 */
export function logOpenIdRequestBody(body: unknown): string {
  try {
    if (body instanceof URLSearchParams) {
      return safeStringify({ type: 'URLSearchParams', fieldCount: body.size });
    }

    if (typeof body === 'string') {
      return safeStringify({ type: 'string', length: body.length });
    }

    return safeStringify({ type: body == null ? typeof body : 'object' });
  } catch {
    return '[OpenID request body metadata unavailable]';
  }
}

/**
 * Helper to log headers without revealing sensitive information
 * @param headers - Headers object to log
 * @returns Stringified headers with sensitive data masked
 */
export function logHeaders(headers: Headers | undefined | null): string {
  try {
    const headerObj: Record<string, string> = {};
    if (!headers || typeof headers.entries !== 'function') {
      return 'No headers available';
    }
    for (const [key, value] of headers.entries()) {
      headerObj[key] = SAFE_OPENID_HEADER_VALUES.has(key.toLowerCase()) ? value : MASKED_VALUE;
    }
    return safeStringify(headerObj);
  } catch {
    return '[OpenID request headers unavailable]';
  }
}

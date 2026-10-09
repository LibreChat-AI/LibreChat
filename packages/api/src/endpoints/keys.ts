import crypto from 'crypto';

/** NUL-delimited scoped keys cannot collide with legacy endpoint-name keys. */
export const SCOPED_TOKEN_CONFIG_KEY_PREFIX = '\u0000token-config:v2\u0000';

type TokenConfigScope = 'tenant' | 'tenant-user';

export function getScopedTokenConfigKey(scope: TokenConfigScope, parts: string[]): string {
  const digest = crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${SCOPED_TOKEN_CONFIG_KEY_PREFIX}${scope}\u0000${digest}`;
}

export function getModelCacheTokenConfigKey(cacheKey: string): string {
  return `${SCOPED_TOKEN_CONFIG_KEY_PREFIX}models\u0000${cacheKey}`;
}

export function isScopedTokenConfigKey(tokenKey: string): boolean {
  return tokenKey.startsWith(SCOPED_TOKEN_CONFIG_KEY_PREFIX);
}

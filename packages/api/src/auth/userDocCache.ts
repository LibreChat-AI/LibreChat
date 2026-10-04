import { createHash } from 'crypto';
import { logger, evictAuthUserDocs } from '@librechat/data-schemas';
import {
  CacheKeys,
  AUTH_USER_DOC_BY_ID_PREFIX,
  AUTH_USER_DOC_CACHE_TTL_MS,
} from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import { cacheConfig } from '~/cache/cacheConfig';

const AUTH_USER_DOC_CACHE_VERSION = 2;
export { AUTH_USER_DOC_CACHE_TTL_MS };

export type AuthUserDocCacheMode = 'off' | 'on';

export interface AuthUserDocCacheStore {
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  set: (key: string, value: unknown, ttl?: number) => Promise<unknown>;
  delete: (key: string) => Promise<unknown>;
}

export interface AuthUserDocCacheKeyInput {
  strategy: string;
  subject?: string;
  issuer?: string;
  tenantId?: string;
  userId?: string;
  scope?: string;
}

interface CachedAuthUserDoc {
  version: number;
  cachedAt: number;
  user: CachedAuthUser;
}

type CachedAuthUser = Omit<Partial<IUser>, '_id'> & {
  _id?: string;
  id?: string;
};

type UserIdInput = {
  _id?: string | { toString(): string };
  id?: string;
};

let warnedAuthUserDocCacheRequiresRedis = false;

export function getAuthUserDocCacheTtlMs(): number {
  return AUTH_USER_DOC_CACHE_TTL_MS;
}

function isAuthUserDocCacheRedisBacked(): boolean {
  return (
    cacheConfig.USE_REDIS &&
    !cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES?.includes(CacheKeys.AUTH_USER_DOC)
  );
}

export function getAuthUserDocCacheMode(): AuthUserDocCacheMode {
  if (process.env.AUTH_USER_CACHE_MODE !== 'on') {
    return 'off';
  }
  if (!isAuthUserDocCacheRedisBacked()) {
    if (!warnedAuthUserDocCacheRequiresRedis) {
      warnedAuthUserDocCacheRequiresRedis = true;
      logger.warn(
        '[authUserDocCache] User request burst caching requires Redis; disabling auth user cache',
      );
    }
    return 'off';
  }
  return 'on';
}

function normalizeKeyPart(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\/+$/, '');
}

function normalizeExactKeyPart(value: string | undefined): string {
  return (value ?? '').trim();
}

export function buildAuthUserDocCacheKey(input: AuthUserDocCacheKeyInput): string | undefined {
  const strategy = input.strategy.trim();
  const subject = input.subject?.trim();
  if (!strategy || !subject) {
    return undefined;
  }

  const digest = createHash('sha256')
    .update(
      [
        normalizeKeyPart(strategy),
        subject,
        normalizeKeyPart(input.issuer),
        normalizeExactKeyPart(input.tenantId),
        normalizeExactKeyPart(input.userId),
        normalizeKeyPart(input.scope),
      ].join('\0'),
    )
    .digest('base64url');

  return `auth-user-doc:v${AUTH_USER_DOC_CACHE_VERSION}:${digest}`;
}

function getUserId(user: UserIdInput): string | undefined {
  const id = user._id ?? user.id;
  if (id == null) {
    return undefined;
  }
  return typeof id === 'string' ? id : id.toString();
}

export function buildAuthUserDocReverseIndexKey(userId: string): string {
  return `${AUTH_USER_DOC_BY_ID_PREFIX}:${userId}`;
}

function sanitizeUserForCache(user: Partial<IUser>): CachedAuthUser {
  const id = getUserId(user);
  const { _id: _ignored, ...rest } = user;
  const sanitized: CachedAuthUser = { ...rest };
  if (id) {
    sanitized._id = id;
    sanitized.id = id;
  }

  delete sanitized.password;
  delete sanitized.refreshToken;
  delete sanitized.totpSecret;
  delete sanitized.pendingTotpSecret;
  delete sanitized.backupCodes;
  delete sanitized.pendingBackupCodes;
  delete sanitized.twoFactorAcknowledgementNonceHash;
  delete sanitized.twoFactorFinalizationNonceHash;
  delete sanitized.federatedTokens;
  delete sanitized.openidTokens;

  return sanitized;
}

async function rememberUserCacheKey(
  store: AuthUserDocCacheStore,
  userId: string,
  cacheKey: string,
  ttlMs: number,
): Promise<void> {
  const indexKey = buildAuthUserDocReverseIndexKey(userId);
  const existing = await store.get<string[]>(indexKey);
  const keys = Array.isArray(existing) ? existing.filter((value) => value !== cacheKey) : [];
  keys.push(cacheKey);
  await store.set(indexKey, keys.slice(-20), ttlMs);
}

export async function getCachedAuthUserDoc(
  store: AuthUserDocCacheStore,
  cacheKey: string,
): Promise<CachedAuthUser | undefined> {
  try {
    const cached = await store.get<CachedAuthUserDoc>(cacheKey);
    if (!cached || cached.version !== AUTH_USER_DOC_CACHE_VERSION || !cached.user) {
      return undefined;
    }
    return cached.user;
  } catch (error) {
    logger.warn('[authUserDocCache] Cache read failed; falling back to user lookup', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * The reverse index is written first and outlives every document it names, so eviction can
 * always find a cached document: when the index write fails, the document is not cached.
 */
export async function setCachedAuthUserDoc(
  store: AuthUserDocCacheStore,
  cacheKey: string,
  user: Partial<IUser>,
): Promise<void> {
  try {
    const sanitized = sanitizeUserForCache(user);
    const userId = getUserId(sanitized);
    if (userId) {
      await rememberUserCacheKey(store, userId, cacheKey, AUTH_USER_DOC_CACHE_TTL_MS * 2);
    }
    await store.set(
      cacheKey,
      {
        version: AUTH_USER_DOC_CACHE_VERSION,
        cachedAt: Date.now(),
        user: sanitized,
      } satisfies CachedAuthUserDoc,
      AUTH_USER_DOC_CACHE_TTL_MS,
    );
  } catch (error) {
    logger.warn('[authUserDocCache] Cache write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function invalidateCachedAuthUserDoc(
  store: AuthUserDocCacheStore | undefined,
  input: { userId?: string; cacheKey?: string },
): Promise<void> {
  if (!store) {
    return;
  }
  await evictAuthUserDocs(store, input);
}

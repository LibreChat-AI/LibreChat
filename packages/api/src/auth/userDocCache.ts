import { createHash } from 'crypto';
import { logger, evictAuthUserDocs, isAuthUserDocEvictionFenced } from '@librechat/data-schemas';
import {
  CacheKeys,
  AUTH_USER_DOC_MAX_AGE_MS,
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
  /** Two cache TTLs after the lookup began; never served later, however late it was written. */
  expiresAt: number;
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
    const isExpired = () => typeof cached.expiresAt !== 'number' || Date.now() > cached.expiresAt;
    if (isExpired()) {
      return undefined;
    }
    /** A recent eviction means this document may predate the change it evicted. */
    const userId = getUserId(cached.user);
    if (!userId || (await isAuthUserDocEvictionFenced(store, userId))) {
      return undefined;
    }
    /** The fence read can stall past both the fence and this document's expiry. */
    return isExpired() ? undefined : cached.user;
  } catch (error) {
    logger.warn('[authUserDocCache] Cache read failed; falling back to user lookup', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Runs the database lookup whose result a cache write may store, and stamps when it began:
 * `setCachedAuthUserDoc` anchors the document's lifetime to that moment.
 */
export async function timeAuthUserLookup<T>(
  lookup: () => Promise<T>,
): Promise<{ result: T; lookupStartedAt: number }> {
  const lookupStartedAt = Date.now();
  return { result: await lookup(), lookupStartedAt };
}

/**
 * The reverse index is written first and outlives every document it names, so eviction can
 * usually find a cached document: when the index write fails, the document is not cached.
 * `lookupStartedAt` is when the database read of `user` began. A document's lifetime is anchored
 * to it rather than to the write: it expires, and is never served, two cache TTLs after the
 * lookup began, however long the writes took. An eviction's fence lasts three TTLs from a moment
 * after any lookup it can race, so it hides every document read before it, including one the
 * reverse index lost.
 */
export async function setCachedAuthUserDoc(
  store: AuthUserDocCacheStore,
  cacheKey: string,
  user: Partial<IUser>,
  lookupStartedAt: number,
): Promise<void> {
  const expiresAt = lookupStartedAt + AUTH_USER_DOC_MAX_AGE_MS;
  if (Date.now() - lookupStartedAt > AUTH_USER_DOC_CACHE_TTL_MS) {
    return;
  }
  try {
    const sanitized = sanitizeUserForCache(user);
    const userId = getUserId(sanitized);
    if (userId) {
      await rememberUserCacheKey(store, userId, cacheKey, AUTH_USER_DOC_CACHE_TTL_MS * 2);
    }
    /** Measured after the index write, which can stall, so the entry still expires on time. */
    const now = Date.now();
    const ttl = Math.min(AUTH_USER_DOC_CACHE_TTL_MS, expiresAt - now);
    if (ttl <= 0) {
      return;
    }
    await store.set(
      cacheKey,
      {
        version: AUTH_USER_DOC_CACHE_VERSION,
        cachedAt: now,
        expiresAt,
        user: sanitized,
      } satisfies CachedAuthUserDoc,
      ttl,
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

import { logger } from '@librechat/data-schemas';
import { getSignedCookies } from '@aws-sdk/cloudfront-signer';
import type { NextFunction, Response } from 'express';
import { INLINE_AVATAR_PATH_PREFIX, INLINE_IMAGE_PATH_PREFIX } from '~/storage/constants';
import { assertPathSegment } from '~/storage/validation';
import { getCloudFrontConfig } from './cloudfront';
import { s3Config } from '~/storage/s3/s3Config';

const DEFAULT_COOKIE_EXPIRY = 1800;

const REQUIRED_CF_COOKIES = [
  'CloudFront-Policy',
  'CloudFront-Signature',
  'CloudFront-Key-Pair-Id',
] as const;

export const CLOUDFRONT_SCOPE_COOKIE = 'LibreChat-CloudFront-Scope';
const unsafePolicySegmentPattern = /[?*[\]\s]/;

export interface CloudFrontCookieScope {
  userId?: string | null;
  tenantId?: string | null;
  storageRegion?: string | null;
  issuedAt?: number | null;
  expiresAt?: number | null;
}

type CloudFrontScopeValue = string | number | { toString(): string } | null | undefined;

type CloudFrontScopeUser = {
  _id?: CloudFrontScopeValue;
  id?: CloudFrontScopeValue;
  tenantId?: CloudFrontScopeValue;
  orgId?: CloudFrontScopeValue;
  storageRegion?: CloudFrontScopeValue;
};

type CloudFrontCookieRequest = {
  cookies?: Partial<Record<string, string>>;
  user?: CloudFrontScopeUser | null;
};

type CloudFrontAuthCookieRefreshRequest = CloudFrontCookieRequest & {
  cloudFrontAuthCookieRefreshResult?: CloudFrontAuthCookieRefreshResult;
};

export type CloudFrontAuthCookieRefreshResult = {
  enabled: boolean;
  attempted: boolean;
  refreshed: boolean;
  reason?: string;
  expiresInSec?: number;
  refreshAfterSec?: number;
};

type CloudFrontCookieRefreshOptions = CloudFrontCookieScope & {
  orgId?: CloudFrontScopeValue;
  force?: boolean;
  refreshWindowSec?: number;
};

type CookieOptions = {
  domain: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'none';
};

function assertPolicyPathSegment(label: string, value: string | null | undefined): string {
  const segment = assertPathSegment(label, value, 'CloudFront cookies');
  if (unsafePolicySegmentPattern.test(segment)) {
    throw new Error(`[CloudFront cookies] ${label} contains unsafe policy characters.`);
  }
  return segment;
}

function getPolicyScopes(
  domain: string,
  { userId, tenantId, storageRegion }: CloudFrontCookieScope,
  includeRegionInPath = false,
): Array<{ resource: string; path: string }> {
  if (!userId) {
    throw new Error('[CloudFront cookies] userId is required for private image access.');
  }

  const safeUserId = assertPolicyPathSegment('userId', userId);
  if (includeRegionInPath) {
    if (storageRegion) {
      assertPolicyPathSegment('storageRegion', storageRegion);
    }
    if (tenantId) {
      const safeTenantId = assertPolicyPathSegment('tenantId', tenantId);
      return [
        {
          resource: `${domain}/${INLINE_IMAGE_PATH_PREFIX}/r/*/t/${safeTenantId}/images/${safeUserId}/*`,
          path: `/${INLINE_IMAGE_PATH_PREFIX}`,
        },
        {
          resource: `${domain}/${INLINE_AVATAR_PATH_PREFIX}/r/*/t/${safeTenantId}/avatars/*`,
          path: `/${INLINE_AVATAR_PATH_PREFIX}`,
        },
      ];
    }

    return [
      {
        resource: `${domain}/${INLINE_IMAGE_PATH_PREFIX}/r/*/images/${safeUserId}/*`,
        path: `/${INLINE_IMAGE_PATH_PREFIX}`,
      },
      {
        resource: `${domain}/${INLINE_AVATAR_PATH_PREFIX}/r/*/avatars/*`,
        path: `/${INLINE_AVATAR_PATH_PREFIX}`,
      },
    ];
  }

  if (tenantId) {
    const safeTenantId = assertPolicyPathSegment('tenantId', tenantId);
    return [
      {
        resource: `${domain}/${INLINE_IMAGE_PATH_PREFIX}/t/${safeTenantId}/images/${safeUserId}/*`,
        path: `/${INLINE_IMAGE_PATH_PREFIX}`,
      },
      {
        resource: `${domain}/${INLINE_AVATAR_PATH_PREFIX}/t/${safeTenantId}/avatars/*`,
        path: `/${INLINE_AVATAR_PATH_PREFIX}`,
      },
    ];
  }

  return [
    {
      resource: `${domain}/${INLINE_IMAGE_PATH_PREFIX}/images/${safeUserId}/*`,
      path: `/${INLINE_IMAGE_PATH_PREFIX}`,
    },
    {
      resource: `${domain}/${INLINE_AVATAR_PATH_PREFIX}/avatars/*`,
      path: `/${INLINE_AVATAR_PATH_PREFIX}`,
    },
  ];
}

function getConfiguredCookieExpiry(): number {
  const config = getCloudFrontConfig();
  return config?.cookieExpiry ?? DEFAULT_COOKIE_EXPIRY;
}

export function getCloudFrontCookieRefreshWindowSec(
  cookieExpiry: number = getConfiguredCookieExpiry(),
): number {
  return Math.min(300, Math.floor(cookieExpiry / 4));
}

export function getCloudFrontCookieTiming(): {
  expiresInSec: number;
  refreshAfterSec: number;
  refreshWindowSec: number;
} {
  const expiresInSec = getConfiguredCookieExpiry();
  const refreshWindowSec = getCloudFrontCookieRefreshWindowSec(expiresInSec);
  return {
    expiresInSec,
    refreshAfterSec: Math.max(0, expiresInSec - refreshWindowSec),
    refreshWindowSec,
  };
}

function getEffectiveCloudFrontScope(
  scope: CloudFrontCookieScope,
  includeRegionInPath: boolean,
): CloudFrontCookieScope {
  const configuredStorageRegion =
    scope.storageRegion ??
    getCloudFrontConfig()?.storageRegion ??
    s3Config.AWS_REGION ??
    process.env.AWS_REGION;
  const scopedStorageRegion = includeRegionInPath ? configuredStorageRegion : scope.storageRegion;
  return {
    ...scope,
    ...(scopedStorageRegion ? { storageRegion: scopedStorageRegion } : {}),
  };
}

function getScopeCookiePaths(
  scope: CloudFrontCookieScope,
  { includeTenantRoot = false }: { includeTenantRoot?: boolean } = {},
): string[] {
  if (!scope.userId) {
    return [];
  }

  if (scope.storageRegion) {
    assertPolicyPathSegment('storageRegion', scope.storageRegion);
  }
  const safeUserId = assertPolicyPathSegment('userId', scope.userId);
  const safeTenantId = scope.tenantId ? assertPolicyPathSegment('tenantId', scope.tenantId) : null;
  const paths = [`/${INLINE_IMAGE_PATH_PREFIX}`, `/${INLINE_AVATAR_PATH_PREFIX}`];
  if (safeTenantId) {
    paths.push(`/t/${safeTenantId}/images/${safeUserId}`, `/t/${safeTenantId}/avatars`);
  } else {
    paths.push(`/images/${safeUserId}`, '/avatars');
  }
  if (safeTenantId && includeTenantRoot) {
    paths.push(`/t/${safeTenantId}`);
  }
  return paths;
}

function encodeCloudFrontCookieScope(scope: CloudFrontCookieScope): string {
  const payload = {
    userId: scope.userId ?? null,
    tenantId: scope.tenantId ?? null,
    storageRegion: scope.storageRegion ?? null,
    issuedAt: scope.issuedAt ?? null,
    expiresAt: scope.expiresAt ?? null,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function parseCloudFrontCookieScope(
  value: string | null | undefined,
): CloudFrontCookieScope | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      userId?: unknown;
      tenantId?: unknown;
      storageRegion?: unknown;
      issuedAt?: unknown;
      expiresAt?: unknown;
    };
    const scope: CloudFrontCookieScope = {};
    if (typeof parsed.userId === 'string') {
      scope.userId = assertPolicyPathSegment('userId', parsed.userId);
    }
    if (typeof parsed.tenantId === 'string') {
      scope.tenantId = assertPolicyPathSegment('tenantId', parsed.tenantId);
    }
    if (typeof parsed.storageRegion === 'string') {
      scope.storageRegion = assertPolicyPathSegment('storageRegion', parsed.storageRegion);
    }
    if (typeof parsed.issuedAt === 'number' && Number.isFinite(parsed.issuedAt)) {
      scope.issuedAt = parsed.issuedAt;
    }
    if (typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt)) {
      scope.expiresAt = parsed.expiresAt;
    }
    return scope.userId ? scope : null;
  } catch {
    return null;
  }
}

function normalizeCloudFrontScopeValue(value: CloudFrontScopeValue): string | undefined {
  if (value == null) {
    return undefined;
  }

  const normalized = String(value);
  return normalized.length > 0 ? normalized : undefined;
}

function getCloudFrontScopeValue(
  optionsValue: CloudFrontScopeValue,
  userValue: CloudFrontScopeValue,
  requestValue: CloudFrontScopeValue,
): string | undefined {
  return normalizeCloudFrontScopeValue(optionsValue ?? userValue ?? requestValue);
}

export function resolveCloudFrontCookieScope(
  req: CloudFrontCookieRequest | null | undefined,
  user: CloudFrontScopeUser | null | undefined,
  options: CloudFrontCookieRefreshOptions = {},
): CloudFrontCookieScope {
  const storageRegion = getCloudFrontScopeValue(
    options.storageRegion,
    user?.storageRegion,
    req?.user?.storageRegion,
  );
  return {
    userId: getCloudFrontScopeValue(
      options.userId,
      user?._id ?? user?.id,
      req?.user?._id ?? req?.user?.id,
    ),
    tenantId: getCloudFrontScopeValue(
      options.tenantId ?? options.orgId,
      user?.tenantId ?? user?.orgId,
      req?.user?.tenantId ?? req?.user?.orgId,
    ),
    ...(storageRegion ? { storageRegion } : {}),
  };
}

function getPreviousCloudFrontScope(
  req: CloudFrontCookieRequest | null | undefined,
): CloudFrontCookieScope | null {
  return parseCloudFrontCookieScope(req?.cookies?.[CLOUDFRONT_SCOPE_COOKIE]);
}

function getCloudFrontCookieSkipReason(scope: CloudFrontCookieScope): string | null {
  const config = getCloudFrontConfig();
  if (!config || config.imageSigning !== 'cookies' || !config.privateKey || !config.keyPairId) {
    return 'cloudfront_disabled';
  }
  if (!config.cookieDomain) {
    return 'missing_cookie_domain';
  }
  if (!scope.userId) {
    return 'missing_user_id';
  }
  return null;
}

function shouldLogCloudFrontCookieSkip(reason: string): boolean {
  return reason !== 'cloudfront_disabled';
}

function getScopeRefreshReason(
  previousScope: CloudFrontCookieScope | null,
  currentScope: CloudFrontCookieScope,
  refreshWindowSec: number,
): string | null {
  if (!previousScope?.userId) {
    return 'missing_scope';
  }
  if (previousScope.userId !== currentScope.userId) {
    return 'user_scope_mismatch';
  }
  if ((previousScope.tenantId ?? null) !== (currentScope.tenantId ?? null)) {
    return 'tenant_scope_mismatch';
  }
  if ((previousScope.storageRegion ?? null) !== (currentScope.storageRegion ?? null)) {
    return 'storage_region_scope_mismatch';
  }

  const expiresAt = Number(previousScope.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return 'missing_expiry';
  }

  const now = Math.floor(Date.now() / 1000);
  if (expiresAt - now <= refreshWindowSec) {
    return 'near_expiry';
  }

  return null;
}

function clearCookiePaths(
  res: Response,
  baseOptions: CookieOptions,
  paths: Iterable<string>,
): void {
  for (const path of paths) {
    const options = { ...baseOptions, path };
    for (const key of REQUIRED_CF_COOKIES) {
      res.clearCookie(key, options);
    }
  }
}

/**
 * Clears CloudFront signed cookies from the response.
 * Should be called during logout to revoke CDN access.
 */
export function clearCloudFrontCookies(res: Response, scope: CloudFrontCookieScope = {}): void {
  try {
    const config = getCloudFrontConfig();
    if (!config?.cookieDomain) {
      return;
    }
    const baseOptions = {
      domain: config.cookieDomain,
      httpOnly: true,
      secure: true,
      sameSite: 'none' as const,
    };
    const paths = new Set(['/images', '/avatars', '/r', '/i', '/a', '/']);
    const clearScope =
      config.includeRegionInPath && scope.userId && !scope.storageRegion
        ? {
            ...scope,
            storageRegion: config.storageRegion ?? s3Config.AWS_REGION ?? process.env.AWS_REGION,
          }
        : scope;
    if (clearScope.userId) {
      for (const path of getScopeCookiePaths(clearScope, {
        includeTenantRoot: true,
      })) {
        paths.add(path);
      }
    }

    clearCookiePaths(res, baseOptions, paths);
    res.clearCookie(CLOUDFRONT_SCOPE_COOKIE, { ...baseOptions, httpOnly: false, path: '/' });
  } catch (error) {
    logger.warn('[clearCloudFrontCookies] Failed to clear cookies:', error);
  }
}

/**
 * Sets CloudFront signed cookies on the response for CDN access.
 * Returns true if cookies were set, false if CloudFront cookies are not enabled.
 */
export function setCloudFrontCookies(
  res: Response,
  scope: CloudFrontCookieScope = {},
  previousScope: CloudFrontCookieScope | null = null,
): boolean {
  const config = getCloudFrontConfig();
  if (
    config?.imageSigning === 'cookies' &&
    config.privateKey &&
    config.keyPairId &&
    config.cookieDomain &&
    !scope.userId
  ) {
    logger.warn('[setCloudFrontCookies] CloudFront configured but userId missing from scope');
    return false;
  }
  if (
    !config ||
    config.imageSigning !== 'cookies' ||
    !config.privateKey ||
    !config.keyPairId ||
    !config.cookieDomain ||
    !scope.userId
  ) {
    return false;
  }

  try {
    const { keyPairId, privateKey } = config;
    const cookieExpiry = getConfiguredCookieExpiry();
    const issuedAtEpoch = Math.floor(Date.now() / 1000);
    const expiresAtEpoch = issuedAtEpoch + cookieExpiry;
    const expiresAtMs = expiresAtEpoch * 1000;
    const expiresAt = new Date(expiresAtMs);

    const cleanDomain = config.domain.replace(/\/+$/, '');
    const includeRegionInPath = config.includeRegionInPath ?? false;
    const effectiveScope = getEffectiveCloudFrontScope(scope, includeRegionInPath);
    const policyScopes = getPolicyScopes(cleanDomain, effectiveScope, includeRegionInPath);
    const resourcesByPath = new Map<string, string[]>();
    for (const { resource, path } of policyScopes) {
      resourcesByPath.set(path, [...(resourcesByPath.get(path) ?? []), resource]);
    }

    const signedCookieSets = Array.from(resourcesByPath, ([path, resources]) => {
      if (resources.length > 1) {
        throw new Error('[CloudFront cookies] Multiple resources cannot share a cookie path.');
      }

      const policy = JSON.stringify({
        Statement: [
          {
            Resource: resources[0],
            Condition: {
              DateLessThan: {
                'AWS:EpochTime': expiresAtEpoch,
              },
            },
          },
        ],
      });

      return {
        path,
        cookies: getSignedCookies({
          keyPairId,
          privateKey,
          policy,
        }),
      };
    });

    const sharedCookieOptions = {
      httpOnly: true,
      secure: true,
      sameSite: 'none' as const,
      domain: config.cookieDomain,
    };
    const stalePaths = new Set(['/images', '/avatars', '/r', '/i', '/a']);
    if (previousScope?.userId) {
      for (const path of getScopeCookiePaths(previousScope)) {
        stalePaths.add(path);
      }
    }
    for (const path of getScopeCookiePaths(effectiveScope)) {
      stalePaths.add(path);
    }

    for (const { cookies } of signedCookieSets) {
      for (const key of REQUIRED_CF_COOKIES) {
        if (!cookies[key]) {
          logger.error(`[setCloudFrontCookies] Missing expected cookie from AWS SDK: ${key}`);
          return false;
        }
      }
    }

    clearCookiePaths(res, sharedCookieOptions, stalePaths);
    const baseCookieOptions = { ...sharedCookieOptions, expires: expiresAt };

    for (const { cookies, path } of signedCookieSets) {
      const cookieOptions = { ...baseCookieOptions, path };
      for (const key of REQUIRED_CF_COOKIES) {
        res.cookie(key, cookies[key], cookieOptions);
      }
    }
    const scopeCookieValue = encodeCloudFrontCookieScope({
      ...effectiveScope,
      issuedAt: issuedAtEpoch,
      expiresAt: expiresAtEpoch,
    });
    res.cookie(CLOUDFRONT_SCOPE_COOKIE, scopeCookieValue, {
      ...baseCookieOptions,
      httpOnly: false,
      path: '/',
    });

    return true;
  } catch (error) {
    logger.error('[setCloudFrontCookies] Failed to generate signed cookies:', error);
    return false;
  }
}

export function maybeRefreshCloudFrontAuthCookies(
  req: CloudFrontCookieRequest | null | undefined,
  res: Response,
  user: CloudFrontScopeUser | null | undefined,
  options: CloudFrontCookieRefreshOptions = {},
): CloudFrontAuthCookieRefreshResult {
  try {
    const config = getCloudFrontConfig();
    const scope = resolveCloudFrontCookieScope(req, user, options);
    const skipReason = getCloudFrontCookieSkipReason(scope);
    const timing = getCloudFrontCookieTiming();

    if (skipReason) {
      if (shouldLogCloudFrontCookieSkip(skipReason)) {
        logger.debug('[maybeRefreshCloudFrontAuthCookies] CloudFront auth cookies skipped', {
          attempted: false,
          refreshed: false,
          reason: skipReason,
          has_user_id: Boolean(scope.userId),
          has_tenant_scope: Boolean(scope.tenantId),
          has_storage_region: Boolean(scope.storageRegion),
        });
      }
      return {
        enabled: false,
        attempted: false,
        refreshed: false,
        reason: skipReason,
      };
    }

    const includeRegionInPath = config?.includeRegionInPath ?? false;
    const effectiveScope = getEffectiveCloudFrontScope(scope, includeRegionInPath);
    const previousScope = getPreviousCloudFrontScope(req);
    const refreshWindowSec = options.refreshWindowSec ?? timing.refreshWindowSec;
    const refreshReason = options.force
      ? 'forced'
      : getScopeRefreshReason(previousScope, effectiveScope, refreshWindowSec);

    if (!refreshReason) {
      return {
        enabled: true,
        attempted: false,
        refreshed: false,
        reason: 'fresh',
        expiresInSec: timing.expiresInSec,
        refreshAfterSec: timing.refreshAfterSec,
      };
    }

    const cookiesSet = setCloudFrontCookies(res, effectiveScope, previousScope);
    const logPayload = {
      attempted: true,
      refreshed: cookiesSet,
      reason: cookiesSet ? refreshReason : 'set_failed',
      refresh_window_sec: refreshWindowSec,
      has_tenant_scope: Boolean(effectiveScope.tenantId),
      has_storage_region: Boolean(effectiveScope.storageRegion),
      has_previous_scope: Boolean(previousScope?.userId),
    };

    if (cookiesSet) {
      return {
        enabled: true,
        attempted: true,
        refreshed: true,
        reason: refreshReason,
        expiresInSec: timing.expiresInSec,
        refreshAfterSec: timing.refreshAfterSec,
      };
    } else {
      logger.warn(
        '[maybeRefreshCloudFrontAuthCookies] CloudFront auth cookie refresh failed',
        logPayload,
      );
    }

    return {
      enabled: true,
      attempted: true,
      refreshed: false,
      reason: 'set_failed',
      expiresInSec: timing.expiresInSec,
      refreshAfterSec: timing.refreshAfterSec,
    };
  } catch (error) {
    logger.warn(
      '[maybeRefreshCloudFrontAuthCookies] Failed to refresh CloudFront auth cookies:',
      error,
    );
    return {
      enabled: false,
      attempted: false,
      refreshed: false,
      reason: 'error',
    };
  }
}

export function forceRefreshCloudFrontAuthCookies(
  req: CloudFrontCookieRequest | null | undefined,
  res: Response,
  user: CloudFrontScopeUser | null | undefined,
  options: CloudFrontCookieRefreshOptions = {},
): CloudFrontAuthCookieRefreshResult {
  return maybeRefreshCloudFrontAuthCookies(req, res, user, { ...options, force: true });
}

export function maybeRefreshCloudFrontAuthCookiesMiddleware(
  req: CloudFrontAuthCookieRefreshRequest,
  res: Response,
  next: NextFunction,
): void {
  req.cloudFrontAuthCookieRefreshResult = maybeRefreshCloudFrontAuthCookies(req, res, req.user);
  next();
}

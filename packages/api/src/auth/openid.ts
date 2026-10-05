import { logger } from '@librechat/data-schemas';
import { ErrorTypes } from 'librechat-data-provider';
import type { IUser, AppConfig, UserMethods, UserRecord } from '@librechat/data-schemas';
import type { FilterQuery } from 'mongoose';
import type {
  GetAppConfig,
  GetBalanceConfig,
  FindBalanceByUser,
  CreateUserIfAbsent,
} from './provision';
import type { OpenIDUserLookupResult } from '~/app/metrics';
import { isMetricsConfigured, recordOpenIDUserLookup } from '~/app/metrics';
import { createUserOnce } from './provision';

export type OpenIdEmailClaims = {
  email?: unknown;
  preferred_username?: unknown;
  upn?: unknown;
  [claim: string]: unknown;
};

export type OpenIdIssuerSource = {
  iss?: string;
  issuer?: string;
  serverMetadata?: () => { issuer?: string } | undefined;
};

type OpenIdLookupField = 'openidId' | 'idOnTheSource';
type OpenIdUserResolution = { user: IUser | null; error: string | null; migration: boolean };

/** The account fields an OpenID login writes from the current callback's claims. */
export type OpenIDProfile = {
  openidId: string;
  openidIssuer?: string;
  username: string;
  name: string;
  email?: string;
  emailVerified: boolean;
  idOnTheSource?: string;
};

const OPENID_DISCOVERY_PATH = '/.well-known/openid-configuration';
const LEGACY_ISSUER_FILTERS: Array<FilterQuery<IUser>['openidIssuer']> = [
  { $exists: false },
  null,
  '',
];

export function normalizeOpenIdIssuer(issuer: string | undefined): string | undefined {
  const normalized = issuer?.trim().replace(/\/+$/, '');
  if (!normalized) return undefined;
  if (!normalized.endsWith(OPENID_DISCOVERY_PATH)) return normalized;
  return normalized.slice(0, -OPENID_DISCOVERY_PATH.length) || undefined;
}

function getIssuerFromSource(source: OpenIdIssuerSource | null | undefined): string | undefined {
  if (source == null) return undefined;

  const issuer = source.iss || source.serverMetadata?.()?.issuer || source.issuer;
  return normalizeOpenIdIssuer(issuer);
}

function getStringClaim(claims: OpenIdEmailClaims, claim: string): string | undefined {
  const value = claims[claim];
  return typeof value === 'string' && value ? value : undefined;
}

export function getOpenIdIssuer(
  ...sources: Array<OpenIdIssuerSource | null | undefined>
): string | undefined {
  for (const source of sources) {
    const issuer = getIssuerFromSource(source);
    if (issuer) return issuer;
  }

  return normalizeOpenIdIssuer(process.env.OPENID_ISSUER);
}

function isLegacyOpenIdIssuer(openidIssuer: string | undefined): boolean {
  const loginIssuer = normalizeOpenIdIssuer(process.env.OPENID_ISSUER);
  return openidIssuer != null && loginIssuer != null && openidIssuer === loginIssuer;
}

function hasOpenIdLookupValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function getElapsedSeconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
}

function getOpenIDUserLookupResult(resolution: OpenIdUserResolution): OpenIDUserLookupResult {
  if (resolution.error) return 'auth_failed';
  if (resolution.migration) return 'migration';
  if (resolution.user) return 'found';
  return 'not_found';
}

function getIssuerExactCondition(
  field: OpenIdLookupField,
  value: string | undefined,
  openidIssuer: string | undefined,
): FilterQuery<IUser> | null {
  if (!hasOpenIdLookupValue(value) || !openidIssuer) return null;
  return { [field]: value, openidIssuer };
}

function getLegacyIssuerConditions(
  field: OpenIdLookupField,
  value: string | undefined,
  openidIssuer: string | undefined,
): FilterQuery<IUser>[] {
  if (!hasOpenIdLookupValue(value) || !isLegacyOpenIdIssuer(openidIssuer)) return [];
  return LEGACY_ISSUER_FILTERS.map((issuerFilter) => ({
    [field]: value,
    openidIssuer: issuerFilter,
  }));
}

export function getIssuerBoundConditions(
  field: OpenIdLookupField,
  value: string | undefined,
  openidIssuer: string | undefined,
): FilterQuery<IUser>[] {
  const exactCondition = getIssuerExactCondition(field, value, openidIssuer);
  if (!exactCondition) return [];
  return [exactCondition, ...getLegacyIssuerConditions(field, value, openidIssuer)];
}

function getPrimaryLookupConditions(
  openidId: string | undefined,
  idOnTheSource: string | undefined,
  openidIssuer: string | undefined,
): FilterQuery<IUser>[] {
  const exactConditions = [
    getIssuerExactCondition('openidId', openidId, openidIssuer),
    getIssuerExactCondition('idOnTheSource', idOnTheSource, openidIssuer),
  ].filter((condition): condition is FilterQuery<IUser> => condition != null);

  return [
    ...exactConditions,
    ...getLegacyIssuerConditions('openidId', openidId, openidIssuer),
    ...getLegacyIssuerConditions('idOnTheSource', idOnTheSource, openidIssuer),
  ];
}

async function findFirstOpenIdUser(
  findUser: UserMethods['findUser'],
  conditions: FilterQuery<IUser>[],
): Promise<IUser | null> {
  for (const condition of conditions) {
    const user = await findUser(condition);
    if (user) return user;
  }

  return null;
}

export function isUserIssuerAllowed(user: IUser, openidIssuer: string | undefined): boolean {
  if (!openidIssuer) return true;

  const userIssuer = normalizeOpenIdIssuer(user.openidIssuer);
  if (userIssuer) return userIssuer === openidIssuer;

  return isLegacyOpenIdIssuer(openidIssuer);
}

function resolveIssuerBoundUser(
  user: IUser | null,
  normalizedIssuer: string | undefined,
  strategyName: string,
  context: string,
): OpenIdUserResolution | null {
  if (!user?.openidId) return null;

  if (!isUserIssuerAllowed(user, normalizedIssuer)) {
    logger.warn(
      `[${strategyName}] Rejected ${context} for ${user.email}: stored openidIssuer does not match token issuer`,
    );
    return { user: null, error: ErrorTypes.AUTH_FAILED, migration: false };
  }

  if (normalizedIssuer && !normalizeOpenIdIssuer(user.openidIssuer)) {
    user.openidIssuer = normalizedIssuer;
    return { user, error: null, migration: true };
  }

  return null;
}

/**
 * Resolves the OpenID user identifier claim, honoring OPENID_EMAIL_CLAIM before
 * email/preferred_username/upn fallbacks.
 */
export function getOpenIdEmail(
  claims: OpenIdEmailClaims | null | undefined,
  strategyName = 'openidStrategy',
): string | undefined {
  if (claims == null) return undefined;

  const claimKey = process.env.OPENID_EMAIL_CLAIM?.trim();
  if (claimKey) {
    const value = claims[claimKey];
    if (typeof value === 'string' && value) return value;
    if (value != null) {
      logger.warn(
        `[${strategyName}] OPENID_EMAIL_CLAIM="${claimKey}" resolved to a non-string value (type: ${typeof value}). Falling back to: email -> preferred_username -> upn.`,
      );
    } else {
      logger.warn(
        `[${strategyName}] OPENID_EMAIL_CLAIM="${claimKey}" not present in userinfo. Falling back to: email -> preferred_username -> upn.`,
      );
    }
  }

  return (
    getStringClaim(claims, 'email') ??
    getStringClaim(claims, 'preferred_username') ??
    getStringClaim(claims, 'upn')
  );
}

/**
 * Finds or migrates a user for OpenID authentication
 * @returns user object (with migration fields if needed), error message, and whether migration is needed
 */
export async function findOpenIDUser({
  openidId,
  findUser,
  email,
  openidIssuer,
  idOnTheSource,
  strategyName = 'openid',
}: {
  openidId: string;
  findUser: UserMethods['findUser'];
  email?: string;
  openidIssuer?: string;
  idOnTheSource?: string;
  strategyName?: string;
}): Promise<OpenIdUserResolution> {
  const lookupStartedAt = isMetricsConfigured() ? process.hrtime.bigint() : null;
  const finish = (resolution: OpenIdUserResolution): OpenIdUserResolution => {
    if (lookupStartedAt != null) {
      recordOpenIDUserLookup(
        getOpenIDUserLookupResult(resolution),
        getElapsedSeconds(lookupStartedAt),
      );
    }
    return resolution;
  };

  try {
    const normalizedIssuer = normalizeOpenIdIssuer(openidIssuer);
    const primaryConditions = getPrimaryLookupConditions(openidId, idOnTheSource, normalizedIssuer);

    let user: IUser | null = null;
    if (primaryConditions.length > 0) {
      user = await findFirstOpenIdUser(findUser, primaryConditions);
    }

    const primaryIssuerResolution = resolveIssuerBoundUser(
      user,
      normalizedIssuer,
      strategyName,
      'OpenID lookup',
    );
    if (primaryIssuerResolution) return finish(primaryIssuerResolution);

    if (!user && email) {
      user = await findUser({ email });
      logger.warn(
        `[${strategyName}] user ${user ? 'found' : 'not found'} with email: ${email} for openidId: ${openidId}`,
      );

      // If user found by email, check if they're allowed to use OpenID provider
      if (user && user.provider && user.provider !== 'openid') {
        logger.warn(
          `[${strategyName}] Attempted OpenID login by user ${user.email}, was registered with "${user.provider}" provider`,
        );
        return finish({ user: null, error: ErrorTypes.AUTH_FAILED, migration: false });
      }

      if (user?.openidId && user.openidId !== openidId) {
        logger.warn(
          `[${strategyName}] Rejected email fallback for ${user.email}: stored openidId does not match token sub`,
        );
        return finish({ user: null, error: ErrorTypes.AUTH_FAILED, migration: false });
      }

      const emailIssuerResolution = resolveIssuerBoundUser(
        user,
        normalizedIssuer,
        strategyName,
        'email fallback',
      );
      if (emailIssuerResolution) return finish(emailIssuerResolution);

      if (user && !user.openidId) {
        logger.info(
          `[${strategyName}] Preparing user ${user.email} for migration to OpenID with sub: ${openidId}`,
        );
        user.provider = 'openid';
        user.openidId = openidId;
        if (normalizedIssuer) user.openidIssuer = normalizedIssuer;
        return finish({ user, error: null, migration: true });
      }
    }

    return finish({ user, error: null, migration: false });
  } catch (error) {
    if (lookupStartedAt != null) {
      recordOpenIDUserLookup('error', getElapsedSeconds(lookupStartedAt));
    }
    throw error;
  }
}

/** Returns `user` carrying the current callback's claims, as every OpenID login refreshes them. */
export function applyOpenIDProfile<T extends UserRecord>(user: T, profile: OpenIDProfile): T {
  const updated = {
    ...user,
    provider: 'openid',
    openidId: profile.openidId,
    username: profile.username,
    name: profile.name,
    idOnTheSource: profile.idOnTheSource,
  };
  if (profile.openidIssuer) {
    updated.openidIssuer = profile.openidIssuer;
  }
  if (profile.email && profile.email !== user.email) {
    updated.email = profile.email;
    updated.emailVerified = profile.emailVerified;
  }
  return updated;
}

/**
 * Creates a first-login OpenID user through `createUserOnce`, which recovers a concurrent first
 * login by repeating `findOpenIDUser`, with its provider and issuer checks, once the winner
 * finished provisioning the account, and admits that account exactly as a found one (tenant
 * config and email-domain policy). The recovered account is refreshed with this callback's
 * claims like any account the lookup finds. Returns the account with the config the login
 * continues under (`appConfig` for a user this request created).
 */
export async function createOpenIDUser({
  lookup,
  profile,
  appConfig,
  getAppConfig,
  getBalanceConfig,
  createUserIfAbsent,
  findBalanceByUser,
}: {
  lookup: Parameters<typeof findOpenIDUser>[0];
  profile: OpenIDProfile;
  appConfig: AppConfig;
  getAppConfig: GetAppConfig;
  getBalanceConfig: GetBalanceConfig;
  createUserIfAbsent: CreateUserIfAbsent;
  findBalanceByUser: FindBalanceByUser;
}): Promise<{ user: UserRecord; appConfig: AppConfig }> {
  const result = await createUserOnce({
    strategyName: lookup.strategyName ?? 'openid',
    newUser: {
      provider: 'openid',
      openidId: profile.openidId,
      username: profile.username,
      email: profile.email || '',
      emailVerified: profile.emailVerified,
      name: profile.name,
      idOnTheSource: profile.idOnTheSource,
      openidIssuer: profile.openidIssuer,
    },
    email: profile.email ?? '',
    appConfig,
    getAppConfig,
    getBalanceConfig,
    lookup: () => findOpenIDUser(lookup),
    createUserIfAbsent,
    findBalanceByUser,
  });
  if (result.error !== null) throw new Error(result.error);
  return {
    user: result.created ? result.user : applyOpenIDProfile(result.user, profile),
    appConfig: result.appConfig,
  };
}

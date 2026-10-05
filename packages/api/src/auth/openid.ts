import { logger } from '@librechat/data-schemas';
import { ErrorTypes } from 'librechat-data-provider';
import type {
  IUser,
  UserMethods,
  UserRecord,
  NewUserData,
  BalanceConfig,
  CreateUserIfAbsentResult,
  AppConfig,
} from '@librechat/data-schemas';
import type { FilterQuery } from 'mongoose';
import type { OpenIDUserLookupResult } from '~/app/metrics';
import { isMetricsConfigured, recordOpenIDUserLookup } from '~/app/metrics';
import { resolveAppConfigForUser } from '~/app/resolve';
import { isEmailDomainAllowed } from './domain';

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

/** Whether new users start with a balance record (the condition data-schemas credits it under). */
function hasStartBalance(balanceConfig?: BalanceConfig | null): boolean {
  return Boolean(balanceConfig?.enabled && balanceConfig.startBalance);
}

/**
 * Creates a first-login OpenID user. Concurrent first logins for one identity all miss
 * `findOpenIDUser`, and `createUserIfAbsent` reports `user_exists` for every insert but the
 * first; a rejected request repeats the lookup, with its provider and issuer checks, and
 * continues as the account that won, admitted and refreshed exactly as if its first lookup had
 * found it: a tenant account resolves its tenant config and that config's email-domain policy
 * applies, and the account carries this callback's claims. Returns the account with the config
 * the login continues under (`appConfig` for a user this request created).
 *
 * It continues only once the winner finished provisioning that account. When the config new
 * users are created under (`appConfig`) sets a start balance, the balance must exist:
 * `createUserIfAbsent` writes it before the user, but a winner on an earlier release adds it with
 * `$inc` after its insert, and login balance sync must not initialize it first; such a login fails
 * as it did before recovery existed. A start balance only the account's tenant config sets is
 * initialized by login balance sync with an insert-only write that cannot be added on top, so it
 * does not hold the login back. A conflict the lookup cannot account for throws.
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
  getAppConfig: Parameters<typeof resolveAppConfigForUser>[0];
  getBalanceConfig: (appConfig: AppConfig) => BalanceConfig | null | undefined;
  createUserIfAbsent: (
    data: NewUserData,
    balanceConfig?: BalanceConfig,
  ) => Promise<CreateUserIfAbsentResult>;
  findBalanceByUser: (userId: string) => Promise<object | null>;
}): Promise<{ user: UserRecord; appConfig: AppConfig }> {
  const created = await createUserIfAbsent(
    {
      provider: 'openid',
      openidId: profile.openidId,
      username: profile.username,
      email: profile.email || '',
      emailVerified: profile.emailVerified,
      name: profile.name,
      idOnTheSource: profile.idOnTheSource,
      openidIssuer: profile.openidIssuer,
    },
    getBalanceConfig(appConfig) ?? undefined,
  );
  if (created.ok) return { user: created.value, appConfig };

  const strategyName = lookup.strategyName ?? 'openid';
  const resolution = await findOpenIDUser(lookup);
  if (resolution.error) throw new Error(ErrorTypes.AUTH_FAILED);
  if (!resolution.user) {
    throw new Error(
      `[${strategyName}] New user conflicts with an account the lookup cannot resolve`,
    );
  }

  const userId = resolution.user._id.toString();
  const accountConfig = resolution.user.tenantId
    ? await resolveAppConfigForUser(getAppConfig, resolution.user)
    : appConfig;
  if (!isEmailDomainAllowed(profile.email ?? '', accountConfig?.registration?.allowedDomains)) {
    logger.error(
      `[${strategyName}] Authentication blocked - email domain not allowed for the recovered account [Identifier: ${profile.email}]`,
    );
    throw new Error('Email domain not allowed');
  }

  if (hasStartBalance(getBalanceConfig(appConfig)) && !(await findBalanceByUser(userId))) {
    logger.warn(
      `[${strategyName}] Concurrent first login found user ${userId} before its start balance; failing this login`,
    );
    throw new Error(ErrorTypes.AUTH_FAILED);
  }

  logger.info(
    `[${strategyName}] Concurrent first login for user ${userId}; continuing as that user`,
  );
  return { user: applyOpenIDProfile(resolution.user, profile), appConfig: accountConfig };
}

import { logger } from '@librechat/data-schemas';
import { ErrorTypes } from 'librechat-data-provider';
import type {
  AppConfig,
  UserRecord,
  NewUserData,
  BalanceConfig,
  CreateUserIfAbsentResult,
} from '@librechat/data-schemas';
import { EMAIL_DOMAIN_NOT_ALLOWED, isEmailDomainAllowed } from './domain';
import { resolveAppConfigForUser } from '~/app/resolve';

/** A login lookup's verdict: the account to continue as (or none yet), or the code the login fails with. */
export type LoginUserResolution = { user: UserRecord | null; error: string | null };

/** A provisioned login account with the config the login continues under, or the code it fails with. */
export type ProvisionedUser =
  | { user: UserRecord; appConfig: AppConfig; error: null }
  | { user: null; error: string };

/** Finds one user by field equality; the caller binds it to its storage (data-schemas `findUser`). */
export type FindUserByFields = (
  fields: Record<string, string | undefined>,
) => Promise<UserRecord | null>;

/** Inserts a first-login user, reporting `user_exists` on a lost race (data-schemas `createUserIfAbsent`). */
export type CreateUserIfAbsent = (
  data: NewUserData,
  balanceConfig?: BalanceConfig,
) => Promise<CreateUserIfAbsentResult>;

/** Finds a user's balance record, or `null` before it is initialized (data-schemas `findBalanceByUser`). */
export type FindBalanceByUser = (userId: string) => Promise<object | null>;

/** Resolves an app config (the strategies' `getAppConfig`). */
export type GetAppConfig = Parameters<typeof resolveAppConfigForUser>[0];

/** Reads the balance settings an app config applies (`@librechat/api` `getBalanceConfig`). */
export type GetBalanceConfig = (appConfig: AppConfig) => BalanceConfig | null | undefined;

export type FirstLoginResult =
  | { user: UserRecord; appConfig: AppConfig; created: boolean; error: null }
  | { user: null; error: string; created: false };

/** Whether new users start with a balance record (the condition data-schemas credits it under). */
function hasStartBalance(balanceConfig?: BalanceConfig | null): boolean {
  return Boolean(balanceConfig?.enabled && balanceConfig.startBalance);
}

/**
 * Inserts a first-login user. Concurrent first logins for one identity all miss the strategy's
 * lookup, and `createUserIfAbsent` reports `user_exists` for every insert but the first. A
 * rejected request repeats `lookup`, with the strategy's provider and identity checks, and
 * resolves to the account that won (`created: false`) admitted exactly as a found account: a
 * tenant account resolves its tenant config and that config's email-domain policy applies. The
 * caller then refreshes it like any account its lookup finds. A user this request created keeps
 * `appConfig`. A conflict the lookup cannot account for throws.
 *
 * It resolves to the winner's account only once the winner finished provisioning it. When the
 * config new users are created under (`appConfig`) sets a start balance, the balance must
 * exist: `createUserIfAbsent` writes it before the user, but a winner on an earlier release adds
 * it with `$inc` after its insert, and login balance sync must not initialize it first; such a
 * login fails as it did before recovery existed. A start balance only the account's tenant
 * config sets is initialized by login balance sync with an insert-only write that cannot be
 * added on top, so it does not hold the login back.
 */
export async function createUserOnce({
  newUser,
  email,
  appConfig,
  getAppConfig,
  getBalanceConfig,
  lookup,
  strategyName,
  createUserIfAbsent,
  findBalanceByUser,
}: {
  newUser: NewUserData;
  email: string;
  appConfig: AppConfig;
  getAppConfig: GetAppConfig;
  getBalanceConfig: GetBalanceConfig;
  lookup: () => Promise<LoginUserResolution>;
  strategyName: string;
  createUserIfAbsent: CreateUserIfAbsent;
  findBalanceByUser: FindBalanceByUser;
}): Promise<FirstLoginResult> {
  const created = await createUserIfAbsent(newUser, getBalanceConfig(appConfig) ?? undefined);
  if (created.ok) return { user: created.value, appConfig, created: true, error: null };

  const resolution = await lookup();
  if (resolution.error) return { user: null, error: resolution.error, created: false };
  if (!resolution.user) {
    throw new Error(
      `[${strategyName}] New user conflicts with an account the lookup cannot resolve`,
    );
  }

  const userId = resolution.user._id.toString();
  const requiresBalance = hasStartBalance(getBalanceConfig(appConfig));
  const [accountConfig, balance] = await Promise.all([
    resolution.user.tenantId ? resolveAppConfigForUser(getAppConfig, resolution.user) : appConfig,
    requiresBalance ? findBalanceByUser(userId) : null,
  ]);
  if (!isEmailDomainAllowed(email, accountConfig?.registration?.allowedDomains)) {
    logger.error(
      `[${strategyName}] Authentication blocked - email domain not allowed for recovered user ${userId}`,
    );
    return { user: null, error: EMAIL_DOMAIN_NOT_ALLOWED, created: false };
  }

  if (requiresBalance && !balance) {
    logger.warn(
      `[${strategyName}] Concurrent first login found user ${userId} before its start balance; failing this login`,
    );
    return { user: null, error: ErrorTypes.AUTH_FAILED, created: false };
  }

  logger.info(
    `[${strategyName}] Concurrent first login for user ${userId}; continuing as that user`,
  );
  return { user: resolution.user, appConfig: accountConfig, created: false, error: null };
}

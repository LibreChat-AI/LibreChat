import { logger } from '@librechat/data-schemas';
import { ErrorTypes } from 'librechat-data-provider';
import type { AppConfig, UserRecord, NewUserData } from '@librechat/data-schemas';
import type {
  GetAppConfig,
  GetBalanceConfig,
  FindUserByFields,
  FindBalanceByUser,
  CreateUserIfAbsent,
  LoginUserResolution,
} from './provision';
import { createUserOnce } from './provision';

export type SocialUserLookup = {
  findUser: FindUserByFields;
  provider: string;
  providerId?: string;
  email?: string;
};

/** Finds a social login's account by provider id, then by email, whichever provider owns it. */
export async function findSocialUser({
  findUser,
  provider,
  providerId,
  email,
}: SocialUserLookup): Promise<UserRecord | null> {
  const providerKey = `${provider}Id`;
  if (providerId && typeof providerId === 'string') {
    const user = await findUser({ [providerKey]: providerId });
    if (user) return user;
  }

  const user = await findUser({ email: email?.trim() });
  if (user) {
    logger.warn(`[${provider}Login] User found by email: ${email} but not by ${providerKey}`);
  }
  return user;
}

/** The account a social first login recovers: an account owned by another provider fails it. */
export async function resolveSocialUser(lookup: SocialUserLookup): Promise<LoginUserResolution> {
  const user = await findSocialUser(lookup);
  if (!user || user.provider === lookup.provider) return { user, error: null };

  logger.info(
    `[${lookup.provider}Login] User ${lookup.email} already exists with provider ${user.provider}`,
  );
  return { user: null, error: ErrorTypes.AUTH_FAILED };
}

/**
 * Creates a social first-login user through `createUserOnce`. A new account goes through
 * `finishNewUser`; an account a concurrent first login created is admitted like a found account
 * and goes through `refreshExistingUser` with the config its login continues under, as any
 * account the login finds does. A failure throws the coded `AUTH_FAILED` error `socialLogin`
 * hands to its passport callback, with the reason (`AUTH_FAILED` or the email-domain policy)
 * as its message.
 */
export async function provisionSocialUser({
  lookup,
  newUser,
  appConfig,
  getAppConfig,
  getBalanceConfig,
  createUserIfAbsent,
  findBalanceByUser,
  finishNewUser,
  refreshExistingUser,
}: {
  lookup: SocialUserLookup;
  newUser: NewUserData;
  appConfig: AppConfig;
  getAppConfig: GetAppConfig;
  getBalanceConfig: GetBalanceConfig;
  createUserIfAbsent: CreateUserIfAbsent;
  findBalanceByUser: FindBalanceByUser;
  finishNewUser: (user: UserRecord) => Promise<UserRecord>;
  refreshExistingUser: (user: UserRecord, appConfig: AppConfig) => Promise<void>;
}): Promise<UserRecord> {
  const result = await createUserOnce({
    newUser,
    email: newUser.email,
    appConfig,
    getAppConfig,
    getBalanceConfig,
    strategyName: `${lookup.provider}Login`,
    lookup: () => resolveSocialUser(lookup),
    createUserIfAbsent,
    findBalanceByUser,
  });
  if (result.error !== null) {
    throw Object.assign(new Error(result.error), { code: ErrorTypes.AUTH_FAILED });
  }
  if (result.created) return finishNewUser(result.user);

  await refreshExistingUser(result.user, result.appConfig);
  return result.user;
}

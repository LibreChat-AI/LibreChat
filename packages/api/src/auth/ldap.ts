import { logger } from '@librechat/data-schemas';
import { ErrorTypes, SystemRoles } from 'librechat-data-provider';
import type { AppConfig, UserRecord } from '@librechat/data-schemas';
import type {
  GetAppConfig,
  GetBalanceConfig,
  ProvisionedUser,
  FindUserByFields,
  FindBalanceByUser,
  CreateUserIfAbsent,
  LoginUserResolution,
} from './provision';
import { createUserOnce } from './provision';

/** Finds the account an LDAP login continues as; one owned by another provider fails the login. */
export async function findLdapUser({
  findUser,
  ldapId,
}: {
  findUser: FindUserByFields;
  ldapId: string;
}): Promise<LoginUserResolution> {
  const user = await findUser({ ldapId });
  if (user && user.provider !== 'ldap') {
    logger.info(`[ldapStrategy] User ${user.email} already exists with provider ${user.provider}`);
    return { user: null, error: ErrorTypes.AUTH_FAILED };
  }
  return { user, error: null };
}

/**
 * Resolves the account an LDAP login continues as, carrying the directory's values: LDAP manages
 * these users' identity, so provider, `ldapId`, email, username and name are overwritten on every
 * login. Without an account, the user is created through `createUserOnce` (the deployment's first
 * user as ADMIN), and an account a concurrent first login created is admitted like a found account
 * and refreshed the same way. Returns the account with the config the login continues under.
 */
export async function provisionLdapUser({
  user,
  ldapId,
  email,
  username,
  name,
  appConfig,
  getAppConfig,
  getBalanceConfig,
  findUser,
  countUsers,
  createUserIfAbsent,
  findBalanceByUser,
}: {
  user: UserRecord | null;
  ldapId: string;
  email: string;
  username: string;
  name: string;
  appConfig: AppConfig;
  getAppConfig: GetAppConfig;
  getBalanceConfig: GetBalanceConfig;
  findUser: FindUserByFields;
  countUsers: () => Promise<number>;
  createUserIfAbsent: CreateUserIfAbsent;
  findBalanceByUser: FindBalanceByUser;
}): Promise<ProvisionedUser> {
  let account = user;
  let accountConfig = appConfig;
  if (!account) {
    const role = (await countUsers()) === 0 ? SystemRoles.ADMIN : SystemRoles.USER;
    const result = await createUserOnce({
      newUser: { provider: 'ldap', ldapId, username, email, emailVerified: true, name, role },
      email,
      appConfig,
      getAppConfig,
      getBalanceConfig,
      strategyName: 'ldapStrategy',
      lookup: () => findLdapUser({ findUser, ldapId }),
      createUserIfAbsent,
      findBalanceByUser,
    });
    if (result.error !== null) return { user: null, error: result.error };
    account = result.user;
    accountConfig = result.appConfig;
  }

  const directoryValues = { provider: 'ldap', ldapId, email, username, name };
  return {
    user: Object.assign({}, account, directoryValues),
    appConfig: accountConfig,
    error: null,
  };
}

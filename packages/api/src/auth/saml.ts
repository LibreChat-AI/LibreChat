import { logger } from '@librechat/data-schemas';
import { ErrorTypes } from 'librechat-data-provider';
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

export const TRANSIENT_SAML_NAME_ID_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';

export type SamlSubjectError = 'missing_name_id' | 'transient_name_id' | 'issuer_mismatch';

export interface SamlSubjectProfile {
  nameID?: string;
  nameIDFormat?: string;
  issuer?: string;
}

export type SamlSubjectResolution =
  | { nameID: string; error?: never }
  | { nameID?: never; error: SamlSubjectError };

export function resolveSamlSubject(
  profile: SamlSubjectProfile | null | undefined,
  expectedIssuer?: string,
): SamlSubjectResolution {
  const nameID = profile?.nameID;
  if (typeof nameID !== 'string' || nameID.trim().length === 0) {
    return { error: 'missing_name_id' };
  }

  if (profile?.nameIDFormat === TRANSIENT_SAML_NAME_ID_FORMAT) {
    return { error: 'transient_name_id' };
  }

  const normalizedExpectedIssuer = expectedIssuer?.trim();
  const issuer = typeof profile?.issuer === 'string' ? profile.issuer.trim() : '';
  if (normalizedExpectedIssuer && issuer !== normalizedExpectedIssuer) {
    return { error: 'issuer_mismatch' };
  }

  return { nameID };
}

/**
 * Finds the account a SAML login continues as: by NameID, then by email. An account owned by
 * another provider or bound to a different NameID fails the login.
 */
export async function findSamlUser({
  findUser,
  nameID,
  email,
}: {
  findUser: FindUserByFields;
  nameID: string;
  email: string;
}): Promise<LoginUserResolution> {
  let user = await findUser({ samlId: nameID });
  logger.info(`[samlStrategy] User ${user ? 'found' : 'not found'} by SAML identity`);

  if (!user) {
    user = await findUser({ email });
    logger.info(`[samlStrategy] User ${user ? 'found' : 'not found'} by SAML email claim`);
  }

  if (user && user.provider !== 'saml') {
    logger.info(`[samlStrategy] SAML login conflicts with existing provider: ${user.provider}`);
    return { user: null, error: ErrorTypes.AUTH_FAILED };
  }

  if (user?.samlId && user.samlId !== nameID) {
    logger.warn('[samlStrategy] Refused SAML login with a different NameID');
    return { user: null, error: ErrorTypes.AUTH_FAILED };
  }

  return { user, error: null };
}

/**
 * Resolves the account a SAML login continues as once the strategy's policy checks pass. A
 * found account claims this login's NameID and profile atomically; without one, the user is
 * created through `createUserOnce`, and an account a concurrent first login created is admitted
 * like a found account and claimed the same way. Returns the account with the config the login
 * continues under.
 */
export async function provisionSamlUser({
  user,
  nameID,
  email,
  username,
  name,
  appConfig,
  getAppConfig,
  getBalanceConfig,
  findUser,
  createUserIfAbsent,
  findBalanceByUser,
  claimSamlIdentity,
}: {
  user: UserRecord | null;
  nameID: string;
  email: string;
  username: string;
  name: string;
  appConfig: AppConfig;
  getAppConfig: GetAppConfig;
  getBalanceConfig: GetBalanceConfig;
  findUser: FindUserByFields;
  createUserIfAbsent: CreateUserIfAbsent;
  findBalanceByUser: FindBalanceByUser;
  claimSamlIdentity: (
    userId: string,
    samlId: string,
    profile: { username: string; name: string },
  ) => Promise<UserRecord | null>;
}): Promise<ProvisionedUser> {
  let account = user;
  let accountConfig = appConfig;
  if (!account) {
    const result = await createUserOnce({
      newUser: { provider: 'saml', samlId: nameID, username, email, emailVerified: true, name },
      email,
      appConfig,
      getAppConfig,
      getBalanceConfig,
      strategyName: 'samlStrategy',
      lookup: () => findSamlUser({ findUser, nameID, email }),
      createUserIfAbsent,
      findBalanceByUser,
    });
    if (result.error !== null) return { user: null, error: result.error };
    if (result.created) return { user: result.user, appConfig: result.appConfig, error: null };
    account = result.user;
    accountConfig = result.appConfig;
  }

  const claimed = await claimSamlIdentity(account._id.toString(), nameID, { username, name });
  if (!claimed) {
    logger.warn('[samlStrategy] Refused a concurrent SAML identity binding');
    return { user: null, error: ErrorTypes.AUTH_FAILED };
  }
  return { user: claimed, appConfig: accountConfig, error: null };
}

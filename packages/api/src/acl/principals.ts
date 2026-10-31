import type { TCustomConfig, TPrincipal } from 'librechat-data-provider';
import { isEnabled } from '~/utils';

export interface DirectoryPrincipalUser {
  id: string;
}

export interface DirectoryPrincipalUserData {
  name?: string;
  email: string;
  emailVerified: false;
  provider: 'openid';
  idOnTheSource: string;
}

export interface DirectoryPrincipalUserMethods {
  findUserBySourceId: (idOnTheSource: string) => Promise<DirectoryPrincipalUser | null>;
  findUserByEmail: (email: string) => Promise<DirectoryPrincipalUser | null>;
  createUser: (user: DirectoryPrincipalUserData) => Promise<string>;
}

type DirectoryPrincipal = Pick<TPrincipal, 'name' | 'email' | 'idOnTheSource'>;

export const ensureDirectoryPrincipalUser = async (
  principal: DirectoryPrincipal,
  methods: DirectoryPrincipalUserMethods,
): Promise<string> => {
  if (!principal.email || !principal.idOnTheSource) {
    throw new Error('Directory user principals must have email and idOnTheSource');
  }

  const userBySourceId = await methods.findUserBySourceId(principal.idOnTheSource);
  if (userBySourceId) {
    return userBySourceId.id;
  }

  const userByEmail = await methods.findUserByEmail(principal.email);
  if (userByEmail) {
    return userByEmail.id;
  }

  return methods.createUser({
    name: principal.name,
    email: principal.email.toLowerCase(),
    emailVerified: false,
    provider: 'openid',
    idOnTheSource: principal.idOnTheSource,
  });
};

/** `permissions.syncOnlyExistingEntraGroups` in `librechat.yaml` takes precedence over the env flag. */
export const syncsOnlyExistingEntraGroups = (
  permissions: TCustomConfig['permissions'],
  envValue: string | undefined,
): boolean => permissions?.syncOnlyExistingEntraGroups ?? isEnabled(envValue);

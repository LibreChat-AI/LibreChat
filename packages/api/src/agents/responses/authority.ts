import { responseTenantId, isResponseTenantId } from './scope';
import { PermissionBits, Permissions, PermissionTypes } from 'librechat-data-provider';
import { getTenantId, SYSTEM_TENANT_ID, tenantStorage } from '@librechat/data-schemas';
import type {
  AppConfig,
  IUser,
  IRole,
  ResponseOwner,
  AgentApiKeyBinding,
} from '@librechat/data-schemas';

import { isTwoFactorEnrollmentRequired } from '~/auth/twoFactor';

export interface BackgroundResponseAuthorityDependencies {
  enrollmentRequired?: typeof isTwoFactorEnrollmentRequired;
  findUser: (userId: string) => Promise<IUser | null>;
  getKey: (
    keyId: string,
    userId: string,
  ) => Promise<{ expiresAt?: Date; binding?: AgentApiKeyBinding } | null>;
  authorizeBinding?: (
    binding: AgentApiKeyBinding,
    keyId: string,
    owner: ResponseOwner,
    agentId: string,
  ) => Promise<boolean>;
  getRole: (role: string) => Promise<IRole | null>;
  getConfig: (user: IUser) => Promise<AppConfig>;
  getAgentPermissions: (agentId: string, user: { id: string; role: string }) => Promise<number>;
  isPrincipalActive: (userId: string) => Promise<boolean>;
  now?: () => number;
}

/** Background work retains its original credential's authority, not the worker's signing key. */
export function createBackgroundResponseAuthority(deps: BackgroundResponseAuthorityDependencies) {
  return async (
    owner: ResponseOwner,
    agentId: string,
    sourceKeyId?: string,
    loadedUser?: IUser,
  ): Promise<boolean> => {
    if (!sourceKeyId || !isResponseTenantId(owner.tenantId)) return false;
    const tenantId = responseTenantId(owner.tenantId);
    const currentTenant = getTenantId();
    if (
      currentTenant != null &&
      currentTenant !== SYSTEM_TENANT_ID &&
      responseTenantId(currentTenant) !== tenantId
    )
      return false;
    return tenantStorage.run({ tenantId, userId: owner.userId }, async () => {
      const user = loadedUser ?? (await deps.findUser(owner.userId));
      if (
        !user ||
        String(user._id) !== owner.userId ||
        !isResponseTenantId(user.tenantId) ||
        responseTenantId(user.tenantId) !== tenantId ||
        !user.role ||
        (deps.enrollmentRequired ?? isTwoFactorEnrollmentRequired)(user)
      )
        return false;
      const [key, role, config, active, permissions] = await Promise.all([
        deps.getKey(sourceKeyId, owner.userId),
        deps.getRole(user.role),
        deps.getConfig(user),
        deps.isPrincipalActive(owner.userId),
        deps.getAgentPermissions(agentId, { id: owner.userId, role: user.role }),
      ]);
      const remote = config.endpoints?.agents?.remoteApi;
      if (
        key?.binding &&
        !(await deps.authorizeBinding?.(
          key.binding,
          sourceKeyId,
          { userId: owner.userId, tenantId },
          agentId,
        ))
      )
        return false;
      return Boolean(
        key &&
          (!key.expiresAt || key.expiresAt.getTime() > (deps.now ?? Date.now)()) &&
          active &&
          role?.permissions?.[PermissionTypes.REMOTE_AGENTS]?.[Permissions.USE] === true &&
          remote?.background?.enabled === true &&
          remote?.auth?.apiKey?.enabled !== false &&
          (permissions & PermissionBits.VIEW) === PermissionBits.VIEW,
      );
    });
  };
}

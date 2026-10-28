import { PermissionBits, ResourceType } from 'librechat-data-provider';
import type { IUser, SystemCapability } from '@librechat/data-schemas';
import { hasManageAgentsCapability } from './reads';

/** ACL implementations may return either plain IDs or objects with a string representation. */
type ResourceId = string | { toString(): string };

type AgentListAccessDeps = {
  hasCapability: (user: IUser, capability: SystemCapability) => Promise<boolean>;
  findAccessibleResources: (params: {
    userId: string;
    role?: string;
    idOnTheSource?: string;
    resourceType: ResourceType;
    requiredPermissions: PermissionBits;
  }) => Promise<ResourceId[]>;
};

export async function getAgentListAccess(
  user: IUser,
  requiredPermissions: PermissionBits,
  deps: AgentListAccessDeps,
): Promise<{ accessibleIds: string[] | null; editableIds: string[] | null }> {
  if (typeof requiredPermissions !== 'number' || requiredPermissions < 1) {
    throw new Error('requiredPermissions must be a positive number');
  }

  const params = {
    userId: user.id,
    role: user.role,
    idOnTheSource: user.idOnTheSource,
    resourceType: ResourceType.AGENT,
  };
  // The normal startup path must not wait for a capability DB read before issuing ACL reads.
  const aclReads = Promise.all([
    deps.findAccessibleResources({ ...params, requiredPermissions }),
    (requiredPermissions & PermissionBits.EDIT) === PermissionBits.EDIT
      ? null
      : deps.findAccessibleResources({ ...params, requiredPermissions: PermissionBits.EDIT }),
  ]);
  // A manager can proceed even if a speculative ACL read rejects before the capability resolves.
  void aclReads.catch(() => undefined);
  if (await hasManageAgentsCapability(user, deps)) {
    return { accessibleIds: null, editableIds: null };
  }

  const [accessibleIds, editableIds] = await aclReads;
  return {
    accessibleIds: accessibleIds.map(String),
    editableIds: editableIds?.map(String) ?? null,
  };
}

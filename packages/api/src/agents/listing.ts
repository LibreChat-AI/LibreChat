import { PermissionBits, ResourceType } from 'librechat-data-provider';
import type { SystemCapability } from '@librechat/data-schemas';
import { hasManageAgentsCapability } from './access';

/** ACL implementations may return either plain IDs or objects with a string representation. */
type ResourceId = string | { toString(): string };

/** The user fields the listing ACL read needs. */
export interface AgentListUser {
  id: string;
  role?: string;
  idOnTheSource?: string;
}

export type AgentListAccessDeps<U extends AgentListUser = AgentListUser> = {
  hasCapability: (user: U, capability: SystemCapability) => Promise<boolean>;
  findAccessibleResources: (params: {
    userId: string;
    role?: string;
    idOnTheSource?: string;
    resourceType: ResourceType;
    requiredPermissions: PermissionBits;
  }) => Promise<ResourceId[]>;
};

export async function getAgentListAccess<U extends AgentListUser>(
  user: U,
  requiredPermissions: PermissionBits,
  deps: AgentListAccessDeps<U>,
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

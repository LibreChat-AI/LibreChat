import { ResourceType, PermissionBits, hasPermissions } from 'librechat-data-provider';
import type { Types } from 'mongoose';

export interface RemoteAgentAccessResult {
  hasAccess: boolean;
  permissions: number;
  agent: { _id: Types.ObjectId; [key: string]: unknown } | null;
}

export interface GetRemoteAgentPermissionsDeps {
  getEffectivePermissions: (params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    resourceId: string | Types.ObjectId;
  }) => Promise<number>;
}

/** AGENT owners automatically have full REMOTE_AGENT permissions */
export async function getRemoteAgentPermissions(
  deps: GetRemoteAgentPermissionsDeps,
  userId: string,
  role: string | undefined,
  resourceId: string | Types.ObjectId,
): Promise<number> {
  const agentPerms = await deps.getEffectivePermissions({
    userId,
    role,
    resourceType: ResourceType.AGENT,
    resourceId,
  });

  if (hasPermissions(agentPerms, PermissionBits.SHARE)) {
    return PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;
  }

  return deps.getEffectivePermissions({
    userId,
    role,
    resourceType: ResourceType.REMOTE_AGENT,
    resourceId,
  });
}

export async function checkRemoteAgentAccess(params: {
  userId: string;
  role?: string;
  agentId: string;
  getAgent: (query: {
    id: string;
  }) => Promise<{ _id: Types.ObjectId; [key: string]: unknown } | null>;
  getEffectivePermissions: (params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    resourceId: string | Types.ObjectId;
  }) => Promise<number>;
}): Promise<RemoteAgentAccessResult> {
  const { userId, role, agentId, getAgent, getEffectivePermissions } = params;

  const agent = await getAgent({ id: agentId });

  if (!agent) {
    return { hasAccess: false, permissions: 0, agent: null };
  }

  const permissions = await getRemoteAgentPermissions(
    { getEffectivePermissions },
    userId,
    role,
    agent._id,
  );

  const hasAccess = hasPermissions(permissions, PermissionBits.VIEW);

  return { hasAccess, permissions, agent };
}

import { logger, ResourceCapabilityMap } from '@librechat/data-schemas';
import {
  ResourceType,
  Permissions,
  PermissionBits,
  PermissionTypes,
} from 'librechat-data-provider';
import type { SystemCapability } from '@librechat/data-schemas';
import type { Types } from 'mongoose';
import type { ScheduleUserContext } from './types';

type AgentAccess = 'ok' | 'missing' | 'forbidden';

export interface AgentFireAccessDeps {
  /** Resolves an agent's internal `_id` by its custom id, or null when it doesn't exist. */
  findAgentObjectId: (agentId: string) => Promise<{ _id: Types.ObjectId } | null>;
  /** Loads a role's permission map by name. */
  getRoleByName: (
    role?: string,
  ) => Promise<{ permissions?: Record<string, Record<string, boolean | undefined>> } | null>;
  /** Whether the user's role grants a system capability (the manage:agents bypass). */
  hasCapability: (user: ScheduleUserContext, capability: SystemCapability) => Promise<boolean>;
  /** Resource ACL check for a specific permission bit. */
  checkPermission: (params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    resourceId: Types.ObjectId;
    requiredPermission: PermissionBits;
  }) => Promise<boolean>;
}

/**
 * Resolves a user's live access to a schedule's target agent, mirroring the loopback
 * chat route's authorization EXACTLY so the create/update precheck and the fire-time
 * precheck accept a schedule iff the actual fire would be accepted:
 *   1) role-level AGENTS:USE (checkAccess on the route; admins do NOT bypass)
 *   2) resource VIEW with the manage:agents capability bypass
 * The two prechecks must never diverge — a create-time VIEW-only check would let a
 * role without AGENTS:USE schedule runs that every fire then rejects, burning failures.
 */
export function createResolveAgentFireAccess(deps: AgentFireAccessDeps) {
  return async function resolveAgentFireAccess(
    agentId: string,
    user: ScheduleUserContext,
  ): Promise<AgentAccess> {
    const agent = await deps.findAgentObjectId(agentId);
    if (agent == null) {
      return 'missing';
    }
    // Mirror the chat route's checkAccess, which reads the role's AGENTS:USE directly
    // and does NOT special-case admins: an admin whose role has AGENTS:USE disabled is
    // rejected there, so the precheck must reject too — otherwise every fire 403s.
    const role = await deps.getRoleByName(user.role);
    if (role?.permissions?.[PermissionTypes.AGENTS]?.[Permissions.USE] !== true) {
      return 'forbidden';
    }
    const capability = ResourceCapabilityMap[ResourceType.AGENT];
    try {
      if (capability != null && (await deps.hasCapability(user, capability))) {
        return 'ok';
      }
    } catch (err) {
      logger.warn(
        `[schedules] agent capability check failed, denying bypass: ${(err as Error).message}`,
      );
    }
    const allowed = await deps.checkPermission({
      userId: user.id,
      role: user.role,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      requiredPermission: PermissionBits.VIEW,
    });
    return allowed ? 'ok' : 'forbidden';
  };
}

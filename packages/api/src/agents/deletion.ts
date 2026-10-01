import { logger, ResourceCapabilityMap } from '@librechat/data-schemas';
import {
  PermissionBits,
  Permissions,
  PermissionTypes,
  ResourceType,
} from 'librechat-data-provider';
import type { IAgent, IRole, IUser, SystemCapability } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import type { AgentManagementProjectionSource } from './management';
import { agentManagementDeleteResponseSchema, mapAgentManagementError } from './management';
import { checkAccessWithRequestCache } from '../middleware/access';

type AgentManagementRecord = AgentManagementProjectionSource & { _id: Types.ObjectId };

export interface AgentManagementDeleteDeps {
  getRoleByName: (roleName: string, fieldsToSelect?: string | string[]) => Promise<IRole | null>;
  getAgentWithVersionCount: (search: {
    id: string;
    tenantId: string;
  }) => Promise<AgentManagementRecord | null>;
  checkPermission: (params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    resourceId: Types.ObjectId;
    requiredPermission: PermissionBits;
  }) => Promise<boolean>;
  hasCapability: (user: IUser, capability: SystemCapability) => Promise<boolean>;
  deleteAgent: (search: { id: string; tenantId: string }) => Promise<IAgent | null>;
}

function sendError(res: Response, code: Parameters<typeof mapAgentManagementError>[0]) {
  const mapped = mapAgentManagementError(code);
  return res.status(mapped.status).json(mapped.body);
}

async function hasManageAgentsCapability(user: IUser, deps: AgentManagementDeleteDeps) {
  const capability = ResourceCapabilityMap[ResourceType.AGENT];
  try {
    return capability != null && (await deps.hasCapability(user, capability));
  } catch (error) {
    logger.warn(
      `[AgentManagement] Agent capability check failed, denying bypass: ${(error as Error).message}`,
    );
    return false;
  }
}

/** Authorize a tenant-scoped deletion, then reuse the Agent model's existing cleanup path. */
export function createAgentManagementDeleteHandler(
  deps: AgentManagementDeleteDeps,
): (req: Request, res: Response) => Promise<Response> {
  return async function deleteAgent(req: Request, res: Response): Promise<Response> {
    try {
      const user = req.user as IUser | undefined;
      if (!user?.id || !user.tenantId) {
        return sendError(res, 'permission_denied');
      }

      const canDelete = await checkAccessWithRequestCache({
        req,
        user,
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE, Permissions.CREATE],
        getRoleByName: deps.getRoleByName,
      });
      if (!canDelete) {
        return sendError(res, 'permission_denied');
      }

      const agent = await deps.getAgentWithVersionCount({
        id: req.params.id,
        tenantId: user.tenantId,
      });
      if (!agent) {
        return sendError(res, 'not_found');
      }

      const canManageAll = await hasManageAgentsCapability(user, deps);
      if (
        !canManageAll &&
        !(await deps.checkPermission({
          userId: user.id,
          role: user.role,
          resourceType: ResourceType.AGENT,
          resourceId: agent._id,
          requiredPermission: PermissionBits.DELETE,
        }))
      ) {
        return sendError(res, 'permission_denied');
      }

      const deleted = await deps.deleteAgent({ id: req.params.id, tenantId: user.tenantId });
      if (!deleted) {
        return sendError(res, 'not_found');
      }

      return res.status(200).json(
        agentManagementDeleteResponseSchema.parse({
          id: req.params.id,
          deleted: true,
        }),
      );
    } catch (error) {
      logger.error('[AgentManagement] Error deleting Agent', error);
      return sendError(res, 'internal_error');
    }
  };
}

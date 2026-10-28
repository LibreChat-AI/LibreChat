import { logger, ResourceCapabilityMap } from '@librechat/data-schemas';
import {
  PermissionBits,
  Permissions,
  PermissionTypes,
  ResourceType,
} from 'librechat-data-provider';
import type { IRole, IUser, SystemCapability } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import type { AgentManagementProjectionSource } from './management';
import {
  agentManagementListSchema,
  mapAgentManagementError,
  projectAgentManagementListResponse,
  projectAgentManagementResponse,
} from './management';
import { checkAccessWithRequestCache } from '../middleware/access';

type AgentManagementRecord = AgentManagementProjectionSource & { _id: Types.ObjectId };

export interface AgentManagementReadDeps {
  getRoleByName: (roleName: string, fieldsToSelect?: string | string[]) => Promise<IRole | null>;
  getAgentWithVersionCount: (search: {
    id: string;
    tenantId: string;
  }) => Promise<AgentManagementRecord | null>;
  getAgentManagementListByAccess: (params: {
    accessibleIds: Types.ObjectId[] | null;
    tenantId: string;
    limit: number;
    after?: string | null;
  }) => Promise<{
    data: AgentManagementRecord[];
    has_more: boolean;
    after: string | null;
  }>;
  findAccessibleResources: (params: {
    userId: string;
    role?: string;
    idOnTheSource?: string;
    resourceType: ResourceType;
    requiredPermissions: PermissionBits;
  }) => Promise<Types.ObjectId[]>;
  checkPermission: (params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    resourceId: Types.ObjectId;
    requiredPermission: PermissionBits;
  }) => Promise<boolean>;
  hasCapability: (user: IUser, capability: SystemCapability) => Promise<boolean>;
}

function sendError(
  res: Response,
  code: Parameters<typeof mapAgentManagementError>[0],
  error?: unknown,
) {
  const mapped = mapAgentManagementError(code, error);
  return res.status(mapped.status).json(mapped.body);
}

async function canUseAgents(req: Request, user: IUser, deps: AgentManagementReadDeps) {
  return await checkAccessWithRequestCache({
    req,
    user,
    permissionType: PermissionTypes.AGENTS,
    permissions: [Permissions.USE],
    getRoleByName: deps.getRoleByName,
  });
}

async function canViewAgent(
  user: IUser,
  agent: AgentManagementRecord,
  deps: AgentManagementReadDeps,
  canManageAll: boolean,
) {
  if (canManageAll) {
    return true;
  }

  return await deps.checkPermission({
    userId: user.id,
    role: user.role,
    resourceType: ResourceType.AGENT,
    resourceId: agent._id,
    requiredPermission: PermissionBits.EDIT,
  });
}

export async function hasManageAgentsCapability(
  user: IUser,
  deps: Pick<AgentManagementReadDeps, 'hasCapability'>,
): Promise<boolean> {
  const capability = ResourceCapabilityMap[ResourceType.AGENT];
  try {
    if (capability != null && (await deps.hasCapability(user, capability))) {
      return true;
    }
  } catch (error) {
    logger.warn(
      `[AgentManagement] Agent capability check failed, denying bypass: ${(error as Error).message}`,
    );
  }
  return false;
}

/** Typed management read handlers; the Express route supplies concrete database and ACL dependencies. */
export function createAgentManagementReadHandlers(deps: AgentManagementReadDeps): {
  list: (req: Request, res: Response) => Promise<Response>;
  get: (req: Request, res: Response) => Promise<Response>;
} {
  async function list(req: Request, res: Response): Promise<Response> {
    const parsedQuery = agentManagementListSchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return sendError(res, 'invalid_request', parsedQuery.error);
    }

    try {
      const user = req.user as IUser | undefined;
      if (!user?.id || !user.tenantId) {
        return sendError(res, 'permission_denied');
      }

      const [canUse, canManageAll] = await Promise.all([
        canUseAgents(req, user, deps),
        hasManageAgentsCapability(user, deps),
      ]);
      if (!canUse) {
        return sendError(res, 'permission_denied');
      }

      const accessibleIds = canManageAll
        ? null
        : await deps.findAccessibleResources({
            userId: user.id,
            role: user.role,
            idOnTheSource: user.idOnTheSource,
            resourceType: ResourceType.AGENT,
            requiredPermissions: PermissionBits.EDIT,
          });
      const result = await deps.getAgentManagementListByAccess({
        accessibleIds,
        tenantId: user.tenantId,
        limit: parsedQuery.data.limit,
        after: parsedQuery.data.cursor,
      });

      return res.status(200).json(projectAgentManagementListResponse(result));
    } catch (error) {
      logger.error('[AgentManagement] Error listing Agents', error);
      return sendError(res, 'internal_error');
    }
  }

  async function get(req: Request, res: Response): Promise<Response> {
    try {
      const user = req.user as IUser | undefined;
      if (!user?.id || !user.tenantId) {
        return sendError(res, 'permission_denied');
      }

      const [canUse, canManageAll, agent] = await Promise.all([
        canUseAgents(req, user, deps),
        hasManageAgentsCapability(user, deps),
        deps.getAgentWithVersionCount({
          id: req.params.id,
          tenantId: user.tenantId,
        }),
      ]);
      if (!canUse) {
        return sendError(res, 'permission_denied');
      }
      if (!agent) {
        return sendError(res, 'not_found');
      }
      if (!(await canViewAgent(user, agent, deps, canManageAll))) {
        return sendError(res, 'permission_denied');
      }

      return res.status(200).json(projectAgentManagementResponse(agent));
    } catch (error) {
      logger.error('[AgentManagement] Error retrieving Agent', error);
      return sendError(res, 'internal_error');
    }
  }

  return { list, get };
}

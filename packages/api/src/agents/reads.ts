import { logger } from '@librechat/data-schemas';
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
  toAgentManagementAccessCode,
  authorizeAgentManagementTarget,
  projectAgentManagementListResponse,
  projectAgentManagementResponse,
} from './management';
import { checkAccessWithRequestCache } from '../middleware/access';
import { hasManageAgentsCapability } from './access';

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

      /** Both checks start together, but a USE denial wins over an ACL outage. */
      const [canUse, authorized] = await Promise.allSettled([
        canUseAgents(req, user, deps),
        authorizeAgentManagementTarget(
          { user, tenantId: user.tenantId, agentId: req.params.id, required: 'EDIT' },
          deps,
        ),
      ]);
      if (canUse.status === 'rejected') {
        throw canUse.reason;
      }
      if (!canUse.value) {
        return sendError(res, 'permission_denied');
      }
      if (authorized.status === 'rejected') {
        throw authorized.reason;
      }
      const authorization = authorized.value;
      if (!authorization.ok) {
        return sendError(res, toAgentManagementAccessCode(authorization.error.code));
      }

      return res.status(200).json(projectAgentManagementResponse(authorization.value.agent));
    } catch (error) {
      logger.error('[AgentManagement] Error retrieving Agent', error);
      return sendError(res, 'internal_error');
    }
  }

  return { list, get };
}

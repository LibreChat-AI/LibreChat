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
  agentManagementUpdateSchema,
  mapAgentManagementError,
  projectAgentManagementResponse,
} from './management';
import { checkAccessWithRequestCache } from '../middleware/access';

type AgentUpdateHandler = (
  req: Request,
  res: Response,
) => Promise<Response | void> | Response | void;

type AgentManagementRecord = AgentManagementProjectionSource & { _id: Types.ObjectId };

export interface AgentManagementUpdateDeps {
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
  updateAgent: AgentUpdateHandler;
}

function sendError(
  res: Response,
  code: Parameters<typeof mapAgentManagementError>[0],
  error?: unknown,
) {
  const mapped = mapAgentManagementError(code, error);
  return res.status(mapped.status).json(mapped.body);
}

function mapUpdateStatus(status: number): Parameters<typeof mapAgentManagementError>[0] {
  if (status === 400 || status === 409) {
    return 'invalid_request';
  }
  if (status === 401 || status === 403) {
    return 'permission_denied';
  }
  if (status === 404) {
    return 'not_found';
  }
  return 'internal_error';
}

function createResponseAdapter(res: Response): {
  response: Response;
  getResult: () => Response | undefined;
} {
  let statusCode = 200;
  let result: Response | undefined;
  const adapter = Object.create(res) as Response;

  adapter.status = ((status: number) => {
    statusCode = status;
    return adapter;
  }) as Response['status'];
  adapter.json = ((body?: AgentManagementProjectionSource) => {
    if (statusCode >= 200 && statusCode < 300 && body != null) {
      result = res.status(statusCode).json(projectAgentManagementResponse(body));
      return result;
    }
    result = sendError(res, mapUpdateStatus(statusCode));
    return result;
  }) as Response['json'];

  return { response: adapter, getResult: () => result };
}

async function hasManageAgentsCapability(user: IUser, deps: AgentManagementUpdateDeps) {
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

/** Validate and authorize Agent Management updates before reusing the browser update flow. */
export function createAgentManagementUpdateHandler(
  deps: AgentManagementUpdateDeps,
): (req: Request, res: Response) => Promise<Response> {
  return async function update(req: Request, res: Response): Promise<Response> {
    try {
      const user = req.user as IUser | undefined;
      if (!user?.id || !user.tenantId) {
        return sendError(res, 'permission_denied');
      }

      const canUpdate = await checkAccessWithRequestCache({
        req,
        user,
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE, Permissions.CREATE],
        getRoleByName: deps.getRoleByName,
      });
      if (!canUpdate) {
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
          requiredPermission: PermissionBits.EDIT,
        }))
      ) {
        return sendError(res, 'permission_denied');
      }

      const parsedBody = agentManagementUpdateSchema.safeParse(req.body);
      if (!parsedBody.success) {
        return sendError(res, 'invalid_request', parsedBody.error);
      }

      req.body = parsedBody.data;
      const adapter = createResponseAdapter(res);
      await deps.updateAgent(req, adapter.response);
      return adapter.getResult() ?? sendError(res, 'internal_error');
    } catch (error) {
      logger.error('[AgentManagement] Error updating Agent', error);
      return sendError(res, 'internal_error');
    }
  };
}

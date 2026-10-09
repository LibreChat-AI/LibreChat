import { logger } from '@librechat/data-schemas';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { IRole, IUser } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { AgentManagementProjectionSource } from './management';
import {
  agentManagementCreateSchema,
  mapAgentManagementError,
  projectAgentManagementResponse,
} from './management';
import { checkAccessWithRequestCache } from '../middleware/access';

type AgentCreateHandler = (
  req: Request,
  res: Response,
) => Promise<Response | void> | Response | void;

export interface AgentManagementCreateDeps {
  getRoleByName: (roleName: string, fieldsToSelect?: string | string[]) => Promise<IRole | null>;
  createAgent: AgentCreateHandler;
}

function sendError(
  res: Response,
  code: Parameters<typeof mapAgentManagementError>[0],
  error?: unknown,
) {
  const mapped = mapAgentManagementError(code, error);
  return res.status(mapped.status).json(mapped.body);
}

function mapCreateStatus(status: number): Parameters<typeof mapAgentManagementError>[0] {
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
    if (statusCode === 201 && body != null) {
      result = res.status(201).json(projectAgentManagementResponse(body));
      return result;
    }
    result = sendError(res, mapCreateStatus(statusCode));
    return result;
  }) as Response['json'];

  return { response: adapter, getResult: () => result };
}

/** Validate and authorize Agent Management creation before reusing the browser creation flow. */
export function createAgentManagementCreateHandler(
  deps: AgentManagementCreateDeps,
): (req: Request, res: Response) => Promise<Response> {
  return async function create(req: Request, res: Response): Promise<Response> {
    try {
      const user = req.user as IUser | undefined;
      if (!user?.id || !user.tenantId) {
        return sendError(res, 'permission_denied');
      }

      const canCreate = await checkAccessWithRequestCache({
        req,
        user,
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE, Permissions.CREATE],
        getRoleByName: deps.getRoleByName,
      });
      if (!canCreate) {
        return sendError(res, 'permission_denied');
      }

      const parsedBody = agentManagementCreateSchema.safeParse(req.body);
      if (!parsedBody.success) {
        return sendError(res, 'invalid_request', parsedBody.error);
      }

      req.body = parsedBody.data;
      const adapter = createResponseAdapter(res);
      await deps.createAgent(req, adapter.response);
      return adapter.getResult() ?? sendError(res, 'internal_error');
    } catch (error) {
      logger.error('[AgentManagement] Error creating Agent', error);
      return sendError(res, 'internal_error');
    }
  };
}

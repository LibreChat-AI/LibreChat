import { ResourceCapabilityMap } from '@librechat/data-schemas';
import {
  Permissions,
  PermissionBits,
  ResourceType,
  PermissionTypes,
} from 'librechat-data-provider';
import type { NextFunction, Request, Response } from 'express';
import type { IAgent, IUser } from '@librechat/data-schemas';
import type { CheckAccessParams } from '../middleware/access';
import { checkAccess } from '../middleware/access';

export type AgentMemoryPartitionAccess = 'allowed' | 'denied' | 'not_found';

interface CheckPermissionParams {
  userId: string;
  role?: string;
  resourceType: ResourceType;
  resourceId: IAgent['_id'];
  requiredPermission: number;
}

interface AgentMemoryPartitionAccessDependencies {
  getAgent: (query: { id: string }, projection: { _id: 1 }) => Promise<Pick<IAgent, '_id'> | null>;
  getRoleByName: CheckAccessParams['getRoleByName'];
  hasCapability: (
    user: IUser,
    capability: (typeof ResourceCapabilityMap)[ResourceType.AGENT],
  ) => Promise<boolean>;
  checkPermission: (params: CheckPermissionParams) => Promise<boolean>;
}

interface AgentMemoryPartitionAccessParams extends AgentMemoryPartitionAccessDependencies {
  req: Request;
  user: IUser;
  agentId: string;
  allowMissingAgent?: boolean;
}

interface AgentMemoryPartitionMiddlewareParams extends AgentMemoryPartitionAccessDependencies {
  source: 'body' | 'query';
  allowMissingAgent?: boolean;
}

export function getMemoryAgentIdParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export async function getAgentMemoryPartitionAccess({
  req,
  user,
  agentId,
  allowMissingAgent = false,
  getAgent,
  getRoleByName,
  hasCapability,
  checkPermission,
}: AgentMemoryPartitionAccessParams): Promise<AgentMemoryPartitionAccess> {
  const [agent, canManageAgents, canUseAgents] = await Promise.all([
    getAgent({ id: agentId }, { _id: 1 }),
    hasCapability(user, ResourceCapabilityMap[ResourceType.AGENT]).catch(() => false),
    checkAccess({
      req,
      user,
      permissionType: PermissionTypes.AGENTS,
      permissions: [Permissions.USE],
      getRoleByName,
    }).catch(() => false),
  ]);

  if (!canUseAgents && !(allowMissingAgent && !agent)) {
    return 'denied';
  }
  if (!agent) {
    return 'not_found';
  }
  if (canManageAgents) {
    return 'allowed';
  }

  const canViewAgent = await checkPermission({
    userId: user.id,
    role: user.role,
    resourceType: ResourceType.AGENT,
    resourceId: agent._id,
    requiredPermission: PermissionBits.VIEW,
  });
  return canViewAgent ? 'allowed' : 'denied';
}

export function createAgentMemoryPartitionMiddleware({
  source,
  allowMissingAgent = false,
  ...dependencies
}: AgentMemoryPartitionMiddlewareParams): (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown> {
  return async (req, res, next) => {
    const value = source === 'body' ? req.body?.agentId : req.query.agentId;
    const agentId = getMemoryAgentIdParam(value);
    if (!agentId) {
      return next();
    }

    try {
      const agentAccess = await getAgentMemoryPartitionAccess({
        req,
        user: req.user as IUser,
        agentId,
        allowMissingAgent,
        ...dependencies,
      });
      if (agentAccess === 'not_found') {
        return allowMissingAgent ? next() : res.status(404).json({ error: 'Agent not found.' });
      }
      if (agentAccess === 'denied') {
        return res.status(403).json({ error: 'Agent access denied.' });
      }
      return next();
    } catch (_error) {
      return res.status(500).json({ error: 'Failed to validate agent access.' });
    }
  };
}

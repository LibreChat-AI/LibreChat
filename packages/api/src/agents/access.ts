import { PermissionBits, ResourceType } from 'librechat-data-provider';
import { logger, ResourceCapabilityMap } from '@librechat/data-schemas';
import type { IUser, SystemCapability } from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import { notFound, accessDenied } from '../middleware/access';
import { getSafeErrorMetadata } from '~/utils/errors';

export type AgentAccessLevel = 'VIEW' | 'EDIT' | 'DELETE' | 'SHARE';

/** ACL permission bit for each level an agent authorization can require. */
const AGENT_ACCESS_BITS: Readonly<Record<AgentAccessLevel, PermissionBits>> = {
  VIEW: PermissionBits.VIEW,
  EDIT: PermissionBits.EDIT,
  DELETE: PermissionBits.DELETE,
  SHARE: PermissionBits.SHARE,
};
const AGENT_ACCESS_LEVELS: readonly AgentAccessLevel[] = ['VIEW', 'EDIT', 'DELETE', 'SHARE'];

/**
 * Why `authorizeAgent` refused. Only `not_found` says whether the user holds the
 * manage-agents capability, so a caller can keep its own missing-agent reply.
 */
export type AgentAccessError = { code: 'not_found'; canManageAll: boolean } | { code: 'forbidden' };

export type AgentAccessErrorCode = AgentAccessError['code'];

export interface AgentAccessUser {
  id: string;
  role?: string;
}

/** The smallest agent record the ACL check needs; `_id` is the ACL resource ID. */
export interface AgentAccessRecord {
  _id: unknown;
}

/**
 * Not exported: only `authorizeAgent` constructs one. The private `grants` member makes
 * the type nominal, so a plain `{ agent }` object is not an authorization. Its parameter
 * type makes an authorization for more levels assignable to one that needs fewer.
 */
class AgentAuthorization<R extends AgentAccessLevel, T extends AgentAccessRecord> {
  private readonly grants: (level: R) => true = () => true;

  constructor(readonly agent: T) {}
}

/**
 * An agent that `authorizeAgent` loaded and authorized for every level in `R`. Only
 * `authorizeAgent` constructs one, so a value of `AuthorizedAgent<'EDIT'>` passed the EDIT
 * check: `AuthorizedAgent<'VIEW'>` is not assignable to it, while an agent authorized for
 * `'VIEW' | 'EDIT'` is.
 */
export type AuthorizedAgent<
  R extends AgentAccessLevel,
  T extends AgentAccessRecord = AgentAccessRecord,
> = AgentAuthorization<R, T>;

export type AuthorizeAgentResult<R extends AgentAccessLevel, T extends AgentAccessRecord> =
  | { ok: true; value: AuthorizedAgent<R, T> }
  | { ok: false; error: AgentAccessError };

export interface AuthorizeAgentParams<R extends AgentAccessLevel, U extends AgentAccessUser> {
  user: U;
  agentId: string;
  /** One level, or several levels that must all be granted. */
  required: R | readonly R[];
}

export interface AuthorizeAgentDeps<T extends AgentAccessRecord, U extends AgentAccessUser> {
  /** Loads the agent by its public ID; returns null when it does not exist for the caller. */
  getAgent: (agentId: string) => Promise<T | null>;
  hasCapability: (user: U, capability: SystemCapability) => Promise<boolean>;
  checkPermission: (params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    resourceId: T['_id'];
    requiredPermission: PermissionBits;
  }) => Promise<boolean>;
}

/**
 * Whether the user holds the admin "manage agents" capability. A failed capability lookup
 * denies the bypass and the caller continues with the ACL check.
 */
export async function hasManageAgentsCapability<U>(
  user: U,
  deps: { hasCapability: (user: U, capability: SystemCapability) => Promise<boolean> },
): Promise<boolean> {
  const capability = ResourceCapabilityMap[ResourceType.AGENT];
  try {
    return capability != null && (await deps.hasCapability(user, capability));
  } catch (error) {
    logger.warn('[authorizeAgent] Agent capability check failed, denying bypass', {
      error: getSafeErrorMetadata(error),
    });
    return false;
  }
}

function toPermissionBits(levels: readonly AgentAccessLevel[]): PermissionBits {
  let bits = 0;
  for (const level of levels) {
    bits |= AGENT_ACCESS_BITS[level];
  }
  return bits;
}

/**
 * Decides whether `user` may act on agent `agentId` at the `required` level.
 * The admin "manage agents" capability grants every level; otherwise the agent ACL must
 * grant all required bits. A missing agent is `not_found` for every user and says whether the
 * capability was held. Load and ACL outages throw.
 */
export async function authorizeAgent<
  R extends AgentAccessLevel,
  T extends AgentAccessRecord,
  U extends AgentAccessUser,
>(
  params: AuthorizeAgentParams<R, U>,
  deps: AuthorizeAgentDeps<T, U>,
): Promise<AuthorizeAgentResult<R, T>> {
  const { user, agentId, required } = params;
  const [canManageAll, agent] = await Promise.all([
    hasManageAgentsCapability(user, deps),
    deps.getAgent(agentId),
  ]);
  if (!agent) {
    return { ok: false, error: { code: 'not_found', canManageAll } };
  }

  if (!canManageAll) {
    const levels: readonly R[] = typeof required === 'string' ? [required] : required;
    const allowed = await deps.checkPermission({
      userId: user.id,
      role: user.role,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      requiredPermission: toPermissionBits(levels),
    });
    if (!allowed) {
      return { ok: false, error: { code: 'forbidden' } };
    }
  }

  return { ok: true, value: new AgentAuthorization<R, T>(agent) };
}

/** What the agent route middleware records on the request after a successful check. */
export type AgentAccessRequest<T extends AgentAccessRecord = AgentAccessRecord> = Request & {
  resourceAccess?: {
    resourceType: ResourceType.AGENT;
    resourceId: T['_id'];
    customResourceId: string;
    permission: number;
    userId: string;
    resourceInfo: T;
  };
};

function toAccessLevels(requiredPermission: number): AgentAccessLevel[] {
  const levels: AgentAccessLevel[] = [];
  let remaining = requiredPermission;
  for (const level of AGENT_ACCESS_LEVELS) {
    const bit = AGENT_ACCESS_BITS[level];
    if ((requiredPermission & bit) === bit) {
      levels.push(level);
      remaining &= ~bit;
    }
  }
  if (levels.length === 0 || remaining !== 0) {
    throw new Error(
      'canAccessAgentResource: requiredPermission must combine VIEW, EDIT, DELETE or SHARE bits',
    );
  }
  return levels;
}

/**
 * Express middleware for agent routes. It reads the agent's public ID from
 * `req.params[resourceIdParam]`, runs `authorizeAgent`, and maps the result to the
 * route's existing 400 / 401 / 404 / 403 / 500 responses. On success the loaded agent
 * is available as `req.resourceAccess.resourceInfo`. A manage-agents user on a missing
 * agent continues to the route handler, which sends its own missing-agent reply.
 */
export function createAgentAccessMiddleware<T extends AgentAccessRecord>(
  options: { requiredPermission: number; resourceIdParam?: string },
  deps: AuthorizeAgentDeps<T, IUser>,
): (req: AgentAccessRequest<T>, res: Response, next: NextFunction) => Promise<Response | void> {
  const { requiredPermission, resourceIdParam = 'id' } = options;
  if (!requiredPermission || typeof requiredPermission !== 'number') {
    throw new Error('canAccessAgentResource: requiredPermission is required and must be a number');
  }
  const required = toAccessLevels(requiredPermission);

  return async function canAccessAgentResource(req, res, next) {
    const agentId = req.params[resourceIdParam];
    if (!agentId) {
      logger.warn(`[canAccessAgentResource] Missing ${resourceIdParam} in route parameters`);
      return res.status(400).json({
        error: 'Bad Request',
        message: `${resourceIdParam} is required`,
      });
    }

    const user = req.user as IUser | undefined;
    if (!user?.id) {
      logger.warn(`[canAccessAgentResource] Unauthenticated request for agent ${agentId}`);
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    try {
      const result = await authorizeAgent({ user, agentId, required }, deps);
      if (!result.ok && result.error.code === 'not_found' && result.error.canManageAll) {
        logger.debug(
          `[canAccessAgentResource] Manage-agents bypass for user ${user.id} on missing agent ${agentId}`,
        );
        return next();
      }
      if (!result.ok && result.error.code === 'not_found') {
        logger.warn(`[canAccessAgentResource] ${ResourceType.AGENT} not found: ${agentId}`);
        return res.status(404).json(notFound(ResourceType.AGENT));
      }
      if (!result.ok) {
        logger.warn(
          `[canAccessAgentResource] User ${user.id} denied access to agent ${agentId} ` +
            `(required permission: ${requiredPermission})`,
        );
        return res.status(403).json(accessDenied(ResourceType.AGENT));
      }

      const { agent } = result.value;
      req.resourceAccess = {
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        customResourceId: agentId,
        permission: requiredPermission,
        userId: user.id,
        resourceInfo: agent,
      };
      return next();
    } catch (error) {
      logger.error('[canAccessAgentResource] Error checking agent access', {
        error: getSafeErrorMetadata(error),
      });
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to check resource access permissions',
      });
    }
  };
}

import { logger, ResourceCapabilityMap } from '@librechat/data-schemas';
import { Permissions, PermissionTypes, PrincipalType, ResourceType } from 'librechat-data-provider';
import type { NextFunction, Response } from 'express';
import type { IRole } from '@librechat/data-schemas';
import type { CapabilityUser, HasCapabilityFn } from './capabilities';
import type { RequestBody, ServerRequest } from '~/types/http';

type ShareResourcePermissions = Partial<Record<Permissions, boolean>>;

interface SharePermissionCache {
  cacheKey: string;
  resourcePerms: ShareResourcePermissions;
}

type ShareRequest = ServerRequest & {
  params: {
    resourceType?: string;
  };
  body: RequestBody & {
    public?: boolean;
    updated?: Array<{
      type?: string;
    }>;
  };
  sharePermissionContext?: SharePermissionCache;
};

interface ShareContext {
  user: CapabilityUser;
  resourceType: ResourceType;
  permissionType: PermissionTypes;
}

export interface SharePolicyDeps {
  getRoleByName: (roleName: string, fieldsToSelect?: string | string[]) => Promise<IRole | null>;
  hasCapability: HasCapabilityFn;
}

type ShareMiddleware = (
  req: ShareRequest,
  res: Response,
  next: NextFunction,
) => Promise<Response | void>;

const resourceToPermissionType: Record<ResourceType, PermissionTypes> = {
  [ResourceType.AGENT]: PermissionTypes.AGENTS,
  /** Environment sharing is capability-gated by MANAGE_CODE_ENVIRONMENTS.
   * RUN_CODE intentionally has no public-sharing bit, so public grants remain denied. */
  [ResourceType.CODE_ENVIRONMENT]: PermissionTypes.RUN_CODE,
  [ResourceType.PROMPTGROUP]: PermissionTypes.PROMPTS,
  [ResourceType.MCPSERVER]: PermissionTypes.MCP_SERVERS,
  [ResourceType.REMOTE_AGENT]: PermissionTypes.REMOTE_AGENTS,
  [ResourceType.SKILL]: PermissionTypes.SKILLS,
  [ResourceType.SHARED_LINK]: PermissionTypes.SHARED_LINKS,
};

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getShareContext(req: ShareRequest, res: Response, action: string): ShareContext | null {
  const { user } = req;
  const role = user?.role;
  if (!user || !role) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
    return null;
  }

  const resourceType = req.params.resourceType as ResourceType | undefined;
  const permissionType = resourceType ? resourceToPermissionType[resourceType] : undefined;
  if (!resourceType || !permissionType) {
    res.status(400).json({
      error: 'Bad Request',
      message: `Unsupported resource type for ${action}: ${req.params.resourceType}`,
    });
    return null;
  }

  return {
    user: {
      id: user.id,
      role,
      tenantId: user.tenantId,
    },
    resourceType,
    permissionType,
  };
}

export function createSharePolicyMiddleware({ getRoleByName, hasCapability }: SharePolicyDeps): {
  checkShareAccess: ShareMiddleware;
  checkSharePublicAccess: ShareMiddleware;
} {
  async function getResourcePerms(
    req: ShareRequest,
    res: Response,
    action: string,
    context?: ShareContext,
  ): Promise<{
    user: CapabilityUser;
    resourceType: ResourceType;
    resourcePerms: ShareResourcePermissions;
  } | null> {
    const resolvedContext = context ?? getShareContext(req, res, action);
    if (!resolvedContext) {
      return null;
    }

    const { user, resourceType, permissionType } = resolvedContext;
    const cacheKey = `${user.role}:${resourceType}`;
    const cached = req.sharePermissionContext;
    if (cached?.cacheKey === cacheKey) {
      return {
        user,
        resourceType,
        resourcePerms: cached.resourcePerms,
      };
    }

    const role = await getRoleByName(user.role);
    if (!role?.permissions) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'No permissions configured for user role',
      });
      return null;
    }

    const resourcePerms = role.permissions[permissionType] ?? {};
    req.sharePermissionContext = {
      cacheKey,
      resourcePerms,
    };

    return {
      user,
      resourceType,
      resourcePerms,
    };
  }

  async function hasResourceManagementCapability(
    user: CapabilityUser,
    resourceType: ResourceType,
  ): Promise<boolean> {
    const capability = ResourceCapabilityMap[resourceType];
    if (!capability) {
      return false;
    }

    try {
      return await hasCapability(user, capability);
    } catch (error) {
      logger.warn(
        `[checkShareAccess] capability check failed, denying bypass: ${formatError(error)}`,
      );
      return false;
    }
  }

  async function checkShareAccess(
    req: ShareRequest,
    res: Response,
    next: NextFunction,
  ): Promise<Response | void> {
    try {
      const context = getShareContext(req, res, 'sharing');
      if (!context) {
        return;
      }

      if (await hasResourceManagementCapability(context.user, context.resourceType)) {
        return next();
      }

      const result = await getResourcePerms(req, res, 'sharing', context);
      if (!result) {
        return;
      }

      const { user, resourceType, resourcePerms } = result;
      const canShare = resourcePerms[Permissions.SHARE] === true;

      if (!canShare) {
        logger.warn(`[checkShareAccess][${user.id}] User denied SHARE for ${resourceType}`);
        return res.status(403).json({
          error: 'Forbidden',
          message: `You do not have permission to share ${resourceType} resources`,
        });
      }

      return next();
    } catch (error) {
      logger.error(`[checkShareAccess][${req.user?.id}] Error checking SHARE permission`, error);
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to check sharing permissions',
      });
    }
  }

  async function checkSharePublicAccess(
    req: ShareRequest,
    res: Response,
    next: NextFunction,
  ): Promise<Response | void> {
    try {
      const { public: isPublic, updated } = req.body;
      const updatesPublicPrincipal =
        Array.isArray(updated) &&
        updated.some((principal) => principal?.type === PrincipalType.PUBLIC);

      if (!isPublic && !updatesPublicPrincipal) {
        return next();
      }

      const result = await getResourcePerms(req, res, 'public sharing');
      if (!result) {
        return;
      }

      const { user, resourceType, resourcePerms } = result;
      const canSharePublic = resourcePerms[Permissions.SHARE_PUBLIC] === true;

      if (!canSharePublic) {
        logger.warn(
          `[checkSharePublicAccess][${user.id}] User denied SHARE_PUBLIC for ${resourceType}`,
        );
        return res.status(403).json({
          error: 'Forbidden',
          message: `You do not have permission to share ${resourceType} resources publicly`,
        });
      }

      return next();
    } catch (error) {
      logger.error(
        `[checkSharePublicAccess][${req.user?.id}] Error checking SHARE_PUBLIC permission`,
        error,
      );
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to check public sharing permissions',
      });
    }
  }

  return {
    checkShareAccess,
    checkSharePublicAccess,
  };
}

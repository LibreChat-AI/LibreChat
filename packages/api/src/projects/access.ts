import { logger } from '@librechat/data-schemas';
import { Permissions, hasProjectsPermission } from 'librechat-data-provider';
import type { NextFunction, Request as ServerRequest, Response as ServerResponse } from 'express';
import type { IRole } from '@librechat/data-schemas';
import { getSafeErrorMetadata } from '~/utils/errors';

export type ProjectsPermission = Permissions.USE | Permissions.CREATE;

export interface ProjectsUser {
  id?: string;
  role?: string | null;
}

export interface ProjectsAccessDeps {
  getRoleByName: (roleName: string, fieldsToSelect?: string | string[]) => Promise<IRole | null>;
}

/**
 * Whether `user`'s role allows a Chat Projects action. A user with no role, or whose role no longer
 * exists, holds none; a role that predates the `PROJECTS` permission type holds its defaults (see
 * `hasProjectsPermission`).
 * A failed role read throws, so an outage is never mistaken for a refusal or a grant.
 */
export async function canUseProjects(
  user: ProjectsUser | null | undefined,
  permission: ProjectsPermission,
  { getRoleByName }: ProjectsAccessDeps,
): Promise<boolean> {
  if (!user?.role) {
    return false;
  }
  const role = await getRoleByName(user.role);
  if (role == null) {
    return false;
  }
  return hasProjectsPermission(
    role?.permissions as Parameters<typeof hasProjectsPermission>[0],
    permission,
  );
}

/** Middleware refusing a Chat Projects route with 403 unless the role allows `permission`. */
export function requireProjectsPermission(
  permission: ProjectsPermission,
  deps: ProjectsAccessDeps,
): (req: ServerRequest, res: ServerResponse, next: NextFunction) => Promise<unknown> {
  return async (req, res, next) => {
    const user = req.user as ProjectsUser | undefined;
    try {
      if (await canUseProjects(user, permission, deps)) {
        return next();
      }
      logger.warn(
        `[PROJECTS] Forbidden: "${req.method} ${req.baseUrl}${req.route?.path ?? ''}" for user ${user?.id}: ${permission}`,
      );
      return res.status(403).json({ message: 'Forbidden: Insufficient permissions' });
    } catch (error) {
      logger.error('[PROJECTS] Permission check failed', getSafeErrorMetadata(error));
      return res.status(500).json({ message: 'Server error' });
    }
  };
}

/**
 * The `canUseProjects` dependency of a turn's project resolution, bound to its requester and
 * memoized so a turn reads the role at most once however many resolutions it runs.
 */
export function projectsAccessFor(
  user: ProjectsUser | null | undefined,
  deps: ProjectsAccessDeps,
): () => Promise<boolean> {
  let allowed: Promise<boolean> | undefined;
  return () => {
    allowed ??= canUseProjects(user, Permissions.USE, deps).catch((error: unknown) => {
      allowed = undefined;
      throw error;
    });
    return allowed;
  };
}

import { logger } from '@librechat/data-schemas';
import { SystemRoles } from 'librechat-data-provider';
import type { NextFunction, Response } from 'express';
import type { ServerRequest } from '~/types/http';

/**
 * Middleware to check if authenticated user has admin role.
 * Should be used AFTER authentication middleware (requireJwtAuth, requireLocalAuth, etc.)
 */
export const requireAdmin = (
  req: ServerRequest,
  res: Response,
  next: NextFunction,
): Response | undefined => {
  if (!req.user) {
    logger.warn('[requireAdmin] No user found in request');
    return res.status(401).json({
      error: 'Authentication required',
      error_code: 'AUTHENTICATION_REQUIRED',
    });
  }

  if (!req.user.role || req.user.role !== SystemRoles.ADMIN) {
    logger.debug(`[requireAdmin] Access denied for non-admin user: ${req.user.email}`);
    return res.status(403).json({
      error: 'Access denied: Admin privileges required',
      error_code: 'ADMIN_REQUIRED',
    });
  }

  next();
};

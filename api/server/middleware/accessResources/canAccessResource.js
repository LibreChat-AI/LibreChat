const { accessDenied } = require('@librechat/api');
const { logger, ResourceCapabilityMap } = require('@librechat/data-schemas');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { checkPermission } = require('~/server/services/PermissionService');

/**
 * Generic base middleware factory that creates middleware to check resource access permissions.
 * This middleware expects MongoDB ObjectIds as resource identifiers for ACL permission checks.
 *
 * @param {Object} options - Configuration options
 * @param {string} options.resourceType - The type of resource (e.g., 'agent', 'file', 'project')
 * @param {number} options.requiredPermission - The permission bit required (1=view, 2=edit, 4=delete, 8=share)
 * @param {string} [options.resourceIdParam='resourceId'] - The name of the route parameter containing the resource ID
 * @param {Function} [options.idResolver] - Optional function to resolve custom IDs to ObjectIds
 * @returns {Function} Express middleware function
 *
 * @example
 * // Direct usage with ObjectId (for resources that use MongoDB ObjectId in routes)
 * router.get('/prompts/:promptId',
 *   canAccessResource({ resourceType: 'prompt', requiredPermission: 1 }),
 *   getPrompt
 * );
 *
 * @example
 * // Usage with custom ID resolver (for resources that use custom string IDs)
 * router.get('/agents/:id',
 *   canAccessResource({
 *     resourceType: 'agent',
 *     requiredPermission: 1,
 *     resourceIdParam: 'id',
 *     idResolver: (customId) => resolveAgentId(customId)
 *   }),
 *   getAgent
 * );
 */
const canAccessResource = (options) => {
  const {
    resourceType,
    requiredPermission,
    resourceIdParam = 'resourceId',
    idResolver = null,
  } = options;

  if (!resourceType || typeof resourceType !== 'string') {
    throw new Error('canAccessResource: resourceType is required and must be a string');
  }

  if (!requiredPermission || typeof requiredPermission !== 'number') {
    throw new Error('canAccessResource: requiredPermission is required and must be a number');
  }

  return async (req, res, next) => {
    try {
      // Extract resource ID from route parameters
      const rawResourceId = req.params[resourceIdParam];

      if (!rawResourceId) {
        logger.warn(`[canAccessResource] Missing ${resourceIdParam} in route parameters`);
        return res.status(400).json({
          error: 'Bad Request',
          message: `${resourceIdParam} is required`,
        });
      }

      // Check if user is authenticated
      if (!req.user || !req.user.id) {
        logger.warn(
          `[canAccessResource] Unauthenticated request for ${resourceType} ${rawResourceId}`,
        );
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required',
        });
      }
      const cap = ResourceCapabilityMap[resourceType];
      let hasCap = false;
      try {
        hasCap = cap != null && (await hasCapability(req.user, cap));
      } catch (err) {
        logger.warn(`[canAccessResource] capability check failed, denying bypass: ${err.message}`);
      }
      if (hasCap) {
        logger.debug(
          `[canAccessResource] ${cap} bypass for user ${req.user.id} on ${resourceType} ${rawResourceId}`,
        );
        return next();
      }
      const userId = req.user.id;
      let resourceId = rawResourceId;
      let resourceInfo = null;

      // Resolve custom ID to ObjectId if resolver is provided
      if (idResolver) {
        logger.debug(
          `[canAccessResource] Resolving ${resourceType} custom ID ${rawResourceId} to ObjectId`,
        );

        const resolutionResult = await idResolver(rawResourceId);

        if (!resolutionResult) {
          logger.warn(`[canAccessResource] ${resourceType} not found: ${rawResourceId}`);
          return res.status(404).json({
            error: 'Not Found',
            message: `${resourceType} not found`,
          });
        }

        // Handle different resolver return formats
        if (typeof resolutionResult === 'string' || resolutionResult._id) {
          resourceId = resolutionResult._id || resolutionResult;
          resourceInfo = typeof resolutionResult === 'object' ? resolutionResult : null;
        } else {
          resourceId = resolutionResult;
        }

        logger.debug(
          `[canAccessResource] Resolved ${resourceType} ${rawResourceId} to ObjectId ${resourceId}`,
        );
      }

      // Check permissions using PermissionService with ObjectId
      const hasPermission = await checkPermission({
        userId,
        role: req.user.role,
        resourceType,
        resourceId,
        requiredPermission,
      });

      if (hasPermission) {
        logger.debug(
          `[canAccessResource] User ${userId} has permission ${requiredPermission} on ${resourceType} ${rawResourceId} (${resourceId})`,
        );

        req.resourceAccess = {
          resourceType,
          resourceId, // MongoDB ObjectId for ACL operations
          customResourceId: rawResourceId, // Original ID from route params
          permission: requiredPermission,
          userId,
          ...(resourceInfo && { resourceInfo }),
        };

        return next();
      }

      logger.warn(
        `[canAccessResource] User ${userId} denied access to ${resourceType} ${rawResourceId} ` +
          `(required permission: ${requiredPermission})`,
      );

      return res.status(403).json(accessDenied(resourceType));
    } catch (error) {
      logger.error(`[canAccessResource] Error checking access for ${resourceType}:`, error);
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to check resource access permissions',
      });
    }
  };
};

module.exports = {
  canAccessResource,
};

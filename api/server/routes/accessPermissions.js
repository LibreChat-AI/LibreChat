const mongoose = require('mongoose');
const express = require('express');
const {
  AccessRoleIds,
  PrincipalType,
  ResourceType,
  PermissionBits,
} = require('librechat-data-provider');
const { createAgentAdminPermissionAccess, isAgentPermissionsAdmin } = require('@librechat/api');
const {
  getUserEffectivePermissions,
  getAllEffectivePermissions,
  updateResourcePermissions,
  getResourcePermissions,
  getResourceRoles,
  searchPrincipals,
} = require('~/server/controllers/PermissionsController');
const {
  checkShareAccess,
  checkSharePublicAccess,
} = require('~/server/middleware/checkSharePublicAccess');
const { requireJwtAuth, checkBan, uaParser, canAccessResource } = require('~/server/middleware');
const { checkPeoplePickerAccess } = require('~/server/middleware/checkPeoplePickerAccess');
const db = require('~/models');
const { findMCPServerByObjectId, getSkillById } = db;

const router = express.Router();

// Apply common middleware
router.use(requireJwtAuth);
router.use(checkBan);
router.use(uaParser);

/**
 * Generic routes for resource permissions
 * Pattern: /api/permissions/{resourceType}/{resourceId}
 */

/**
 * GET /api/permissions/search-principals
 * Search for users and groups to grant permissions
 */
router.get('/search-principals', checkPeoplePickerAccess, searchPrincipals);

/**
 * GET /api/permissions/{resourceType}/roles
 * Get available roles for a resource type
 */
router.get('/:resourceType/roles', getResourceRoles);

/**
 * Middleware factory to check resource access for permission-related operations.
 * SECURITY: Users must have SHARE permission to view or modify resource permissions.
 * @param {string} requiredPermission - The permission bit required (e.g., SHARE)
 * @returns Express middleware function
 */
const checkResourcePermissionAccess = (requiredPermission) =>
  createAgentAdminPermissionAccess({
    getAgent: db.getAgent,
    fallback: (req, res, next) => {
      const { resourceType } = req.params;
      let middleware;

      if (resourceType === ResourceType.AGENT) {
        middleware = canAccessResource({
          resourceType: ResourceType.AGENT,
          requiredPermission,
          resourceIdParam: 'resourceId',
        });
      } else if (resourceType === ResourceType.REMOTE_AGENT) {
        middleware = canAccessResource({
          resourceType: ResourceType.REMOTE_AGENT,
          requiredPermission,
          resourceIdParam: 'resourceId',
        });
      } else if (resourceType === ResourceType.PROMPTGROUP) {
        middleware = canAccessResource({
          resourceType: ResourceType.PROMPTGROUP,
          requiredPermission,
          resourceIdParam: 'resourceId',
        });
      } else if (resourceType === ResourceType.MCPSERVER) {
        middleware = canAccessResource({
          resourceType: ResourceType.MCPSERVER,
          requiredPermission,
          resourceIdParam: 'resourceId',
          idResolver: findMCPServerByObjectId,
        });
      } else if (resourceType === ResourceType.SKILL) {
        middleware = canAccessResource({
          resourceType: ResourceType.SKILL,
          requiredPermission,
          resourceIdParam: 'resourceId',
          idResolver: getSkillById,
        });
      } else if (resourceType === ResourceType.CODE_ENVIRONMENT) {
        middleware = canAccessResource({
          resourceType: ResourceType.CODE_ENVIRONMENT,
          requiredPermission,
          resourceIdParam: 'resourceId',
        });
      } else if (resourceType === ResourceType.SHARED_LINK) {
        middleware = canAccessResource({
          resourceType: ResourceType.SHARED_LINK,
          requiredPermission,
          resourceIdParam: 'resourceId',
        });
      } else {
        return res.status(400).json({
          error: 'Bad Request',
          message: `Unsupported resource type: ${resourceType}`,
        });
      }

      // Execute the middleware
      middleware(req, res, next);
    },
  });

const checkShareAccessUnlessAgentAdmin = (req, res, next) => {
  if (isAgentPermissionsAdmin(req)) {
    return next();
  }
  return checkShareAccess(req, res, next);
};

const rejectSharedLinkOwnerPermissionChanges = async (req, res, next) => {
  if (req.params.resourceType !== ResourceType.SHARED_LINK) {
    return next();
  }

  const updated = Array.isArray(req.body?.updated) ? req.body.updated : [];
  const removed = Array.isArray(req.body?.removed) ? req.body.removed : [];
  const grantsOwner = updated.some(
    (principal) => principal?.accessRoleId === AccessRoleIds.SHARED_LINK_OWNER,
  );
  const grantsPublicOwner = req.body?.publicAccessRoleId === AccessRoleIds.SHARED_LINK_OWNER;

  if (grantsOwner || grantsPublicOwner) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Shared link owner permissions cannot be changed',
    });
  }

  const userMutations = [...updated, ...removed].filter(
    (principal) => principal?.type === PrincipalType.USER && principal?.id,
  );

  if (userMutations.length === 0) {
    return next();
  }

  try {
    const SharedLink = mongoose.models.SharedLink;
    const link = await SharedLink.findById(req.params.resourceId, 'user').lean();
    const ownerId = link?.user?.toString();
    const touchesOwner = ownerId
      ? userMutations.some((principal) => principal.id?.toString() === ownerId)
      : false;

    if (touchesOwner) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Shared link owner permissions cannot be changed',
      });
    }
  } catch (_error) {
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to validate shared link owner permissions',
    });
  }

  return next();
};

/**
 * GET /api/permissions/{resourceType}/{resourceId}
 * Get all permissions for a specific resource
 * SECURITY: Requires SHARE permission to view resource permissions
 */
router.get(
  '/:resourceType/:resourceId',
  checkResourcePermissionAccess(PermissionBits.SHARE),
  getResourcePermissions,
);

/**
 * PUT /api/permissions/{resourceType}/{resourceId}
 * Bulk update permissions for a specific resource
 * SECURITY: Requires resource ACL SHARE and role SHARE to modify resource permissions
 * SECURITY: Requires SHARE_PUBLIC permission to enable public sharing
 */
router.put(
  '/:resourceType/:resourceId',
  checkResourcePermissionAccess(PermissionBits.SHARE),
  checkShareAccessUnlessAgentAdmin,
  checkSharePublicAccess,
  rejectSharedLinkOwnerPermissionChanges,
  updateResourcePermissions,
);

/**
 * GET /api/permissions/{resourceType}/effective/all
 * Get user's effective permissions for all accessible resources of a type
 */
router.get('/:resourceType/effective/all', getAllEffectivePermissions);

/**
 * GET /api/permissions/{resourceType}/{resourceId}/effective
 * Get user's effective permissions for a specific resource
 */
router.get('/:resourceType/:resourceId/effective', getUserEffectivePermissions);

module.exports = router;

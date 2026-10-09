/**
 * @import { TUpdateResourcePermissionsRequest, TUpdateResourcePermissionsResponse } from 'librechat-data-provider'
 */

const mongoose = require('mongoose');
const { logger, getTenantId, SYSTEM_TENANT_ID } = require('@librechat/data-schemas');
const { ResourceType, PrincipalType, PermissionBits } = require('librechat-data-provider');
const {
  enrichRemoteAgentPrincipals,
  createPrincipalSearch,
  backfillRemoteAgentPermissions,
  auditInsightsPermissionChanges,
  getInsightsPrincipalState,
  maskAgentInsightsBit,
  sanitizeInsightsPermissionPrincipals,
  validateInsightsPermissionUpdates,
} = require('@librechat/api');
const {
  bulkUpdateResourcePermissions,
  restoreInsightsPermissionChanges,
  ensureGroupPrincipalExists,
  getResourcePermissionsMap,
  findAccessibleResources,
  getEffectivePermissions,
  ensurePrincipalExists,
  getAvailableRoles,
} = require('~/server/services/PermissionService');
const {
  entraIdPrincipalFeatureEnabled,
  searchEntraIdPrincipals,
} = require('~/server/services/GraphApiService');
const db = require('~/models');
const { invalidateCodeEnvironmentConfigCache } = require('~/server/services/Config');

const matchesCurrentTenant = (principal, tenantId) => {
  if (!tenantId || tenantId === SYSTEM_TENANT_ID) {
    return true;
  }
  return principal?.tenantId === tenantId;
};

/**
 * Generic controller for resource permission endpoints
 * Delegates validation and logic to PermissionService
 */

/**
 * Validates that the resourceType is one of the supported enum values
 * @param {string} resourceType - The resource type to validate
 * @throws {Error} If resourceType is not valid
 */
const validateResourceType = (resourceType) => {
  const validTypes = Object.values(ResourceType);
  if (!validTypes.includes(resourceType)) {
    throw new Error(`Invalid resourceType: ${resourceType}. Valid types: ${validTypes.join(', ')}`);
  }
};

/**
 * Bulk update permissions for a resource (grant, update, remove)
 * @route PUT /api/{resourceType}/{resourceId}/permissions
 * @param {Object} req - Express request object
 * @param {Object} req.params - Route parameters
 * @param {string} req.params.resourceType - Resource type (e.g., 'agent')
 * @param {string} req.params.resourceId - Resource ID
 * @param {TUpdateResourcePermissionsRequest} req.body - Request body
 * @param {Object} res - Express response object
 * @returns {Promise<TUpdateResourcePermissionsResponse>} Updated permissions response
 */
const updateResourcePermissions = async (req, res) => {
  try {
    const { resourceType, resourceId } = req.params;
    validateResourceType(resourceType);

    /** @type {TUpdateResourcePermissionsRequest} */
    const { updated, removed, public: isPublic, publicAccessRoleId } = req.body;
    const { id: userId } = req.user;
    const updatedList = Array.isArray(updated) ? updated : [];
    const removedList = Array.isArray(removed) ? removed : [];
    const insightsValidation = validateInsightsPermissionUpdates({
      resourceType,
      userRole: req.user.role,
      updatedPrincipals: updatedList,
    });
    if (insightsValidation) {
      return res.status(insightsValidation.status).json({ error: insightsValidation.error });
    }

    // Prepare principals for the service call
    const updatedPrincipals = [];
    const revokedPrincipals = [];

    // Add updated principals
    if (updatedList.length > 0) {
      updatedPrincipals.push(...updatedList);
    }

    // Add public permission if enabled
    if (isPublic && publicAccessRoleId) {
      updatedPrincipals.push({
        type: PrincipalType.PUBLIC,
        id: null,
        accessRoleId: publicAccessRoleId,
      });
    }

    // Prepare authentication context for enhanced group member fetching
    const useEntraId = entraIdPrincipalFeatureEnabled(req.user);
    const authHeader = req.headers.authorization;
    const accessToken =
      authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
    const authContext =
      useEntraId && accessToken
        ? {
            accessToken,
            sub: req.user.openidId,
          }
        : null;

    // Ensure updated principals exist in the database before processing permissions
    const validatedPrincipals = [];
    for (const principal of updatedPrincipals) {
      try {
        let principalId;

        if (principal.type === PrincipalType.PUBLIC) {
          principalId = null; // Public principals don't need database records
        } else if (principal.type === PrincipalType.ROLE) {
          principalId = principal.id; // Role principals use role name as ID
        } else if (principal.type === PrincipalType.USER) {
          principalId = await ensurePrincipalExists(principal);
        } else if (principal.type === PrincipalType.GROUP) {
          // Pass authContext to enable member fetching for Entra ID groups when available
          principalId = await ensureGroupPrincipalExists(principal, authContext);
        } else {
          logger.error(`Unsupported principal type: ${principal.type}`);
          continue; // Skip invalid principal types
        }

        // Update the principal with the validated ID for ACL operations
        validatedPrincipals.push({
          ...principal,
          id: principalId,
        });
      } catch (error) {
        logger.error('Error ensuring principal exists:', {
          principal: {
            type: principal.type,
            id: principal.id,
            name: principal.name,
            source: principal.source,
          },
          error: error.message,
        });
        // Continue with other principals instead of failing the entire operation
        continue;
      }
    }

    // Add removed principals
    if (removedList.length > 0) {
      revokedPrincipals.push(...removedList);
    }

    // If public is explicitly disabled, add public to revoked list
    if (isPublic === false) {
      revokedPrincipals.push({
        type: PrincipalType.PUBLIC,
        id: null,
      });
    }

    const results = await bulkUpdateResourcePermissions({
      resourceType,
      resourceId,
      maxWriteAttempts: req.config?.config?.permissions?.maxWriteAttempts,
      updatedPrincipals: validatedPrincipals,
      revokedPrincipals,
      grantedBy: userId,
    });

    await auditInsightsPermissionChanges({
      req,
      resourceId,
      changes: results.insightsChanges ?? [],
      failClosed: process.env.AUDIT_LOG_FAIL_CLOSED === 'true',
      deps: {
        getAgent: db.getAgent,
        recordAuditEntry: db.recordAuditEntry,
        restoreInsightsPermissionChanges: (changes) =>
          restoreInsightsPermissionChanges({
            resourceType: ResourceType.AGENT,
            resourceId,
            changes,
          }),
        logger,
      },
    });

    if (resourceType === ResourceType.CODE_ENVIRONMENT) {
      await invalidateCodeEnvironmentConfigCache(req.user.tenantId).catch((error) => {
        // Cached environment metadata is authorization-filtered against the live ACL on every
        // read, so a failed revision write may delay a grant but cannot preserve a revocation.
        logger.error('[PermissionsController] code environment cache invalidation failed:', error);
      });
    }

    const isAgentResource =
      resourceType === ResourceType.AGENT || resourceType === ResourceType.REMOTE_AGENT;
    const revokedUserIds = results.revoked
      .filter((p) => p.type === PrincipalType.USER && p.id)
      .map((p) => p.id);

    if (isAgentResource && revokedUserIds.length > 0) {
      db.removeAgentFromUserFavorites(resourceId, revokedUserIds).catch((err) => {
        logger.error('[removeRevokedAgentFromFavorites] Error cleaning up favorites', err);
      });
    }

    /** @type {TUpdateResourcePermissionsResponse} */
    const responsePrincipals = sanitizeInsightsPermissionPrincipals({
      resourceType,
      userRole: req.user.role,
      principals: results.granted,
    });
    const response = {
      message: 'Permissions updated successfully',
      results: {
        principals: responsePrincipals,
        ...(isPublic !== undefined ? { public: isPublic } : {}),
        publicAccessRoleId: isPublic ? publicAccessRoleId : undefined,
      },
    };

    res.status(200).json(response);
  } catch (error) {
    logger.error('Error updating resource permissions:', error);
    res.status(error.statusCode ?? 400).json({
      error: 'Failed to update permissions',
      details: error.message,
    });
  }
};

/**
 * Get principals with their permission roles for a resource (UI-friendly format)
 * Uses efficient aggregation pipeline to join User/Group data in single query
 * @route GET /api/permissions/{resourceType}/{resourceId}
 */
const getResourcePermissions = async (req, res) => {
  try {
    const { resourceType, resourceId } = req.params;
    validateResourceType(resourceType);
    const tenantId = getTenantId();

    const results = await db.aggregateAclEntries([
      // Match ACL entries for this resource
      {
        $match: {
          resourceType,
          resourceId: mongoose.Types.ObjectId.isValid(resourceId)
            ? mongoose.Types.ObjectId.createFromHexString(resourceId)
            : resourceId,
        },
      },
      // Lookup AccessRole information
      {
        $lookup: {
          from: 'accessroles',
          localField: 'roleId',
          foreignField: '_id',
          as: 'role',
        },
      },
      // Lookup User information (for user principals)
      {
        $lookup: {
          from: 'users',
          localField: 'principalId',
          foreignField: '_id',
          as: 'userInfo',
        },
      },
      // Lookup Group information (for group principals)
      {
        $lookup: {
          from: 'groups',
          localField: 'principalId',
          foreignField: '_id',
          as: 'groupInfo',
        },
      },
      // Project final structure
      {
        $project: {
          principalType: 1,
          principalId: 1,
          accessRoleId: { $arrayElemAt: ['$role.accessRoleId', 0] },
          userInfo: { $arrayElemAt: ['$userInfo', 0] },
          groupInfo: { $arrayElemAt: ['$groupInfo', 0] },
          permBits: 1,
        },
      },
    ]);

    let principals = [];
    let publicPermission = null;

    for (const result of results) {
      if (result.principalType === PrincipalType.PUBLIC) {
        publicPermission = {
          public: true,
          publicAccessRoleId: result.accessRoleId,
        };
      } else if (
        result.principalType === PrincipalType.USER &&
        result.userInfo &&
        matchesCurrentTenant(result.userInfo, tenantId)
      ) {
        principals.push({
          type: PrincipalType.USER,
          id: result.userInfo._id.toString(),
          name: result.userInfo.name || result.userInfo.username,
          email: result.userInfo.email,
          avatar: result.userInfo.avatar,
          source: !result.userInfo._id ? 'entra' : 'local',
          idOnTheSource: result.userInfo.idOnTheSource || result.userInfo._id.toString(),
          accessRoleId: result.accessRoleId,
          ...getInsightsPrincipalState({
            principalType: PrincipalType.USER,
            principalRole: result.userInfo.role,
            requesterRole: req.user.role,
            permBits: result.permBits,
          }),
        });
      } else if (
        result.principalType === PrincipalType.GROUP &&
        result.groupInfo &&
        matchesCurrentTenant(result.groupInfo, tenantId)
      ) {
        principals.push({
          type: PrincipalType.GROUP,
          id: result.groupInfo._id.toString(),
          name: result.groupInfo.name,
          email: result.groupInfo.email,
          description: result.groupInfo.description,
          avatar: result.groupInfo.avatar,
          source: result.groupInfo.source || 'local',
          idOnTheSource: result.groupInfo.idOnTheSource || result.groupInfo._id.toString(),
          accessRoleId: result.accessRoleId,
          ...getInsightsPrincipalState({
            principalType: PrincipalType.GROUP,
            requesterRole: req.user.role,
            permBits: result.permBits,
          }),
        });
      } else if (result.principalType === PrincipalType.ROLE) {
        principals.push({
          type: PrincipalType.ROLE,
          /** Role name as ID */
          id: result.principalId,
          /** Display the role name */
          name: result.principalId,
          description: `System role: ${result.principalId}`,
          accessRoleId: result.accessRoleId,
          ...getInsightsPrincipalState({
            principalType: PrincipalType.ROLE,
            principalRole: result.principalId,
            requesterRole: req.user.role,
            permBits: result.permBits,
          }),
        });
      }
    }

    if (resourceType === ResourceType.REMOTE_AGENT) {
      const enricherDeps = {
        aggregateAclEntries: db.aggregateAclEntries,
        bulkWriteAclEntries: db.bulkWriteAclEntries,
        findRoleByIdentifier: db.findRoleByIdentifier,
        logger,
      };
      const enrichResult = await enrichRemoteAgentPrincipals(enricherDeps, resourceId, principals);
      principals = enrichResult.principals;
      backfillRemoteAgentPermissions(enricherDeps, resourceId, enrichResult.entriesToBackfill);
    }

    // Return response in format expected by frontend
    const response = {
      resourceType,
      resourceId,
      principals,
      public: publicPermission?.public || false,
      ...(publicPermission?.publicAccessRoleId && {
        publicAccessRoleId: publicPermission.publicAccessRoleId,
      }),
    };

    res.status(200).json(response);
  } catch (error) {
    logger.error('Error getting resource permissions principals:', error);
    res.status(500).json({
      error: 'Failed to get permissions principals',
      details: error.message,
    });
  }
};

/**
 * Get available roles for a resource type
 * @route GET /api/{resourceType}/roles
 */
const getResourceRoles = async (req, res) => {
  try {
    const { resourceType } = req.params;
    validateResourceType(resourceType);

    const roles = await getAvailableRoles({ resourceType });

    res.status(200).json(
      roles.map((role) => ({
        accessRoleId: role.accessRoleId,
        name: role.name,
        description: role.description,
        permBits: role.permBits,
      })),
    );
  } catch (error) {
    logger.error('Error getting resource roles:', error);
    res.status(500).json({
      error: 'Failed to get roles',
      details: error.message,
    });
  }
};

/**
 * Get user's effective permission bitmask for a resource
 * @route GET /api/{resourceType}/{resourceId}/effective
 */
const getUserEffectivePermissions = async (req, res) => {
  try {
    const { resourceType, resourceId } = req.params;
    validateResourceType(resourceType);

    const { id: userId } = req.user;

    const permissionBits = await getEffectivePermissions({
      userId,
      role: req.user.role,
      resourceType,
      resourceId,
    });

    res.status(200).json({
      permissionBits: maskAgentInsightsBit({
        resourceType,
        userRole: req.user.role,
        permBits: permissionBits,
      }),
    });
  } catch (error) {
    logger.error('Error getting user effective permissions:', error);
    res.status(500).json({
      error: 'Failed to get effective permissions',
      details: error.message,
    });
  }
};

/**
 * Search for users and groups to grant permissions
 * Supports hybrid local database + Entra ID search when configured
 * @route GET /api/permissions/search-principals
 */
const searchPrincipals = createPrincipalSearch({
  searchPrincipals: db.searchPrincipals,
  calculateRelevanceScore: db.calculateRelevanceScore,
  sortPrincipalsByRelevance: db.sortPrincipalsByRelevance,
  entraIdPrincipalFeatureEnabled,
  searchEntraIdPrincipals,
});

/**
 * Get user's effective permissions for all accessible resources of a type
 * @route GET /api/permissions/{resourceType}/effective/all
 */
const getAllEffectivePermissions = async (req, res) => {
  try {
    const { resourceType } = req.params;
    validateResourceType(resourceType);

    const { id: userId } = req.user;

    // Find all resources the user has at least VIEW access to
    const accessibleResourceIds = await findAccessibleResources({
      userId,
      role: req.user.role,
      resourceType,
      requiredPermissions: PermissionBits.VIEW,
    });

    if (accessibleResourceIds.length === 0) {
      return res.status(200).json({});
    }

    // Get effective permissions for all accessible resources
    const permissionsMap = await getResourcePermissionsMap({
      userId,
      role: req.user.role,
      resourceType,
      resourceIds: accessibleResourceIds,
    });

    // Convert Map to plain object for JSON response
    const result = {};
    for (const [resourceId, permBits] of permissionsMap) {
      result[resourceId] = maskAgentInsightsBit({
        resourceType,
        userRole: req.user.role,
        permBits,
      });
    }

    res.status(200).json(result);
  } catch (error) {
    logger.error('Error getting all effective permissions:', error);
    res.status(500).json({
      error: 'Failed to get all effective permissions',
      details: error.message,
    });
  }
};

module.exports = {
  updateResourcePermissions,
  getResourcePermissions,
  getResourceRoles,
  getUserEffectivePermissions,
  getAllEffectivePermissions,
  searchPrincipals,
};

const mongoose = require('mongoose');
const { AccessControlService, isEnabled, ensureDirectoryPrincipalUser } = require('@librechat/api');
const {
  tenantStorage,
  getTenantId,
  logger,
  runAfterTransaction,
} = require('@librechat/data-schemas');
const { ResourceType, PrincipalType } = require('librechat-data-provider');
const {
  entraIdPrincipalFeatureEnabled,
  getUserOwnedEntraGroups,
  getUserEntraGroups,
  getEntraGroupDetailsBatch,
  getGroupMembers,
  getGroupOwners,
} = require('~/server/services/GraphApiService');
const db = require('~/models');

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

const ensureLocalUserPrincipalExists = async (principalId) => {
  const user = await db.findUser({ _id: principalId }, '_id');
  if (!user) {
    throw new Error('User principal not found');
  }
  return user._id.toString();
};

const ensureLocalGroupPrincipalExists = async (principalId) => {
  const group = await db.findGroupById(principalId, { _id: 1 });
  if (!group) {
    throw new Error('Group principal not found');
  }
  return group._id.toString();
};

/**
 * @import { TPrincipal } from 'librechat-data-provider'
 */
/**
 * Grant a permission to a principal for a resource using a role
 * @param {Object} params - Parameters for granting role-based permission
 * @param {string} params.principalType - PrincipalType.USER, PrincipalType.GROUP, or PrincipalType.PUBLIC
 * @param {string|mongoose.Types.ObjectId|null} params.principalId - The ID of the principal (null for PrincipalType.PUBLIC)
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @param {string|mongoose.Types.ObjectId} params.resourceId - The ID of the resource
 * @param {string} params.accessRoleId - The ID of the role (e.g., AccessRoleIds.AGENT_VIEWER, AccessRoleIds.AGENT_EDITOR)
 * @param {string|mongoose.Types.ObjectId} params.grantedBy - User ID granting the permission
 * @param {mongoose.ClientSession} [params.session] - Optional MongoDB session for transactions
 * @returns {Promise<Object>} The created or updated ACL entry
 */
const grantPermission = async ({
  principalType,
  principalId,
  resourceType,
  resourceId,
  accessRoleId,
  grantedBy,
  session,
}) => {
  try {
    if (!Object.values(PrincipalType).includes(principalType)) {
      throw new Error(`Invalid principal type: ${principalType}`);
    }

    if (principalType !== PrincipalType.PUBLIC && !principalId) {
      throw new Error('Principal ID is required for user, group, and role principals');
    }

    // Validate principalId based on type
    if (principalId && principalType === PrincipalType.ROLE) {
      // Role IDs are strings (role names)
      if (typeof principalId !== 'string' || principalId.trim().length === 0) {
        throw new Error(`Invalid role ID: ${principalId}`);
      }
    } else if (
      principalType &&
      principalType !== PrincipalType.PUBLIC &&
      !mongoose.Types.ObjectId.isValid(principalId)
    ) {
      // User and Group IDs must be valid ObjectIds
      throw new Error(`Invalid principal ID: ${principalId}`);
    }

    if (!resourceId || !mongoose.Types.ObjectId.isValid(resourceId)) {
      throw new Error(`Invalid resource ID: ${resourceId}`);
    }

    validateResourceType(resourceType);

    // Get the role to determine permission bits
    const role = await db.findRoleByIdentifier(accessRoleId);
    if (!role) {
      throw new Error(`Role ${accessRoleId} not found`);
    }

    // Ensure the role is for the correct resource type
    if (role.resourceType !== resourceType) {
      throw new Error(
        `Role ${accessRoleId} is for ${role.resourceType} resources, not ${resourceType}`,
      );
    }
    const result = await db.grantPermission(
      principalType,
      principalId,
      resourceType,
      resourceId,
      role.permBits,
      grantedBy,
      session,
      role._id,
    );
    if (resourceType === ResourceType.PROMPTGROUP) {
      /** A caller-owned session may not have committed yet; invalidating early
       * would let a concurrent read re-cache pre-commit IDs under the new generation. */
      await runAfterTransaction(session, () => db.invalidatePromptGroupAccessContext());
    }
    return result;
  } catch (error) {
    logger.error(`[PermissionService.grantPermission] Error: ${error.message}`);
    throw error;
  }
};

/**
 * Check if a user has specific permission bits on a resource
 * @param {Object} params - Parameters for checking permissions
 * @param {string|mongoose.Types.ObjectId} params.userId - The ID of the user
 * @param {string} [params.role] - Optional user role (if not provided, will query from DB)
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @param {string|mongoose.Types.ObjectId} params.resourceId - The ID of the resource
 * @param {number} params.requiredPermissions - The permission bits required (e.g., 1 for VIEW, 3 for VIEW+EDIT)
 * @returns {Promise<boolean>} Whether the user has the required permission bits
 */
const checkPermission = async ({ userId, role, resourceType, resourceId, requiredPermission }) => {
  try {
    if (typeof requiredPermission !== 'number' || requiredPermission < 1) {
      throw new Error('requiredPermission must be a positive number');
    }

    validateResourceType(resourceType);

    const principals = await db.getUserPrincipals({ userId, role });

    if (principals.length === 0) {
      return false;
    }

    return await db.hasPermission(principals, resourceType, resourceId, requiredPermission);
  } catch (error) {
    logger.error(`[PermissionService.checkPermission] Error: ${error.message}`);
    if (error.message.includes('requiredPermission must be')) {
      throw error;
    }
    return false;
  }
};

/**
 * Get effective permission bitmask for a user on a resource
 * @param {Object} params - Parameters for getting effective permissions
 * @param {string|mongoose.Types.ObjectId} params.userId - The ID of the user
 * @param {string} [params.role] - Optional user role (if not provided, will query from DB)
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @param {string|mongoose.Types.ObjectId} params.resourceId - The ID of the resource
 * @returns {Promise<number>} Effective permission bitmask
 */
const getEffectivePermissions = async ({ userId, role, resourceType, resourceId }) => {
  try {
    validateResourceType(resourceType);

    const principals = await db.getUserPrincipals({ userId, role });

    if (principals.length === 0) {
      return 0;
    }

    return await db.getEffectivePermissions(principals, resourceType, resourceId);
  } catch (error) {
    logger.error(`[PermissionService.getEffectivePermissions] Error: ${error.message}`);
    return 0;
  }
};

/**
 * Get effective permissions for multiple resources in a batch operation
 * Returns map of resourceId → effectivePermissionBits
 *
 * @param {Object} params - Parameters
 * @param {string|mongoose.Types.ObjectId} params.userId - User ID
 * @param {string} [params.role] - User role (for group membership)
 * @param {string} params.resourceType - Resource type (must be valid ResourceType)
 * @param {Array<mongoose.Types.ObjectId>} params.resourceIds - Array of resource IDs
 * @returns {Promise<Map<string, number>>} Map of resourceId string → permission bits
 * @throws {Error} If resourceType is invalid
 */
const getResourcePermissionsMap = async ({ userId, role, resourceType, resourceIds }) => {
  // Validate resource type - throw on invalid type
  validateResourceType(resourceType);

  // Handle empty input
  if (!Array.isArray(resourceIds) || resourceIds.length === 0) {
    return new Map();
  }

  try {
    // Get user principals (user + groups + public)
    const principals = await db.getUserPrincipals({ userId, role });

    // Use batch method from aclEntry
    const permissionsMap = await db.getEffectivePermissionsForResources(
      principals,
      resourceType,
      resourceIds,
    );

    logger.debug(
      `[PermissionService.getResourcePermissionsMap] Computed permissions for ${resourceIds.length} resources, ${permissionsMap.size} have permissions`,
    );

    return permissionsMap;
  } catch (error) {
    logger.error(`[PermissionService.getResourcePermissionsMap] Error: ${error.message}`, error);
    throw error;
  }
};

/**
 * Find all resources of a specific type that a user has access to with specific permission bits
 * @param {Object} params - Parameters for finding accessible resources
 * @param {string|mongoose.Types.ObjectId} params.userId - The ID of the user
 * @param {string} [params.role] - Optional user role (if not provided, will query from DB)
 * @param {string|null} [params.idOnTheSource] - Optional external member id. `null` means "known to
 * be absent" (local user); only `undefined` makes `getUserPrincipals` read the user document.
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @param {number} params.requiredPermissions - The minimum permission bits required (e.g., 1 for VIEW, 3 for VIEW+EDIT)
 * @returns {Promise<Array>} Array of resource IDs
 */
const findAccessibleResources = async ({
  userId,
  role,
  idOnTheSource,
  resourceType,
  requiredPermissions,
}) => {
  try {
    if (typeof requiredPermissions !== 'number' || requiredPermissions < 1) {
      throw new Error('requiredPermissions must be a positive number');
    }

    validateResourceType(resourceType);

    // Get all principals for the user (user + groups + public)
    const principalsList = await db.getUserPrincipals({ userId, role, idOnTheSource });

    if (principalsList.length === 0) {
      return [];
    }
    return await db.findAccessibleResources(principalsList, resourceType, requiredPermissions);
  } catch (error) {
    logger.error(`[PermissionService.findAccessibleResources] Error: ${error.message}`);
    // Re-throw validation errors
    if (error.message.includes('requiredPermissions must be')) {
      throw error;
    }
    return [];
  }
};

/**
 * Find all publicly accessible resources of a specific type
 * @param {Object} params - Parameters for finding publicly accessible resources
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @param {number} params.requiredPermissions - The minimum permission bits required (e.g., 1 for VIEW, 3 for VIEW+EDIT)
 * @returns {Promise<Array>} Array of resource IDs
 */
const findPubliclyAccessibleResources = async ({ resourceType, requiredPermissions }) => {
  try {
    if (typeof requiredPermissions !== 'number' || requiredPermissions < 1) {
      throw new Error('requiredPermissions must be a positive number');
    }

    validateResourceType(resourceType);

    return await db.findPublicResourceIds(resourceType, requiredPermissions);
  } catch (error) {
    logger.error(`[PermissionService.findPubliclyAccessibleResources] Error: ${error.message}`);
    if (error.message.includes('requiredPermissions must be')) {
      throw error;
    }
    return [];
  }
};

/**
 * Get available roles for a resource type
 * @param {Object} params - Parameters for getting available roles
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @returns {Promise<Array>} Array of role definitions
 */
const getAvailableRoles = async ({ resourceType }) => {
  validateResourceType(resourceType);

  return await db.findRolesByResourceType(resourceType);
};

/**
 * Ensures a principal exists in the database based on TPrincipal data
 * Creates user if it doesn't exist locally (for Entra ID users)
 * @param {Object} principal - TPrincipal object from frontend
 * @param {string} principal.type - PrincipalType.USER, PrincipalType.GROUP, or PrincipalType.PUBLIC
 * @param {string} [principal.id] - Local database ID (null for Entra ID principals not yet synced)
 * @param {string} principal.name - Display name
 * @param {string} [principal.email] - Email address
 * @param {string} [principal.source] - 'local' or 'entra'
 * @param {string} [principal.idOnTheSource] - Entra ID object ID for external principals
 * @returns {Promise<string|null>} Returns the principalId for database operations, null for public
 */
const ensurePrincipalExists = async function (principal) {
  if (principal.type === PrincipalType.PUBLIC) {
    return null;
  }

  if (principal.type === PrincipalType.USER && principal.id) {
    return await ensureLocalUserPrincipalExists(principal.id);
  }

  if (principal.type === PrincipalType.USER && principal.source === 'entra') {
    return ensureDirectoryPrincipalUser(principal, {
      findUserBySourceId: async (idOnTheSource) => {
        const user = await db.findUser({ idOnTheSource });
        return user ? { id: user._id.toString() } : null;
      },
      findUserByEmail: async (email) => {
        const user = await db.findUser({ email });
        return user ? { id: user._id.toString() } : null;
      },
      createUser: async (userData) => {
        const userId = await db.createUser(userData, true, true);
        return userId.toString();
      },
    });
  }

  if (principal.type === PrincipalType.GROUP) {
    throw new Error('Group principals should be handled by group-specific methods');
  }

  throw new Error(`Unsupported principal type: ${principal.type}`);
};

/**
 * Ensures a group principal exists in the database based on TPrincipal data
 * Creates group if it doesn't exist locally (for Entra ID groups)
 * For Entra ID groups, always synchronizes member IDs when authentication context is provided
 * @param {Object} principal - TPrincipal object from frontend
 * @param {string} principal.type - Must be PrincipalType.GROUP
 * @param {string} [principal.id] - Local database ID (null for Entra ID principals not yet synced)
 * @param {string} principal.name - Display name
 * @param {string} [principal.email] - Email address
 * @param {string} [principal.description] - Group description
 * @param {string} [principal.source] - 'local' or 'entra'
 * @param {string} [principal.idOnTheSource] - Entra ID object ID for external principals
 * @param {Object} [authContext] - Optional authentication context for fetching member data
 * @param {string} [authContext.accessToken] - Access token for Graph API calls
 * @param {string} [authContext.sub] - Subject identifier
 * @returns {Promise<string>} Returns the groupId for database operations
 */
const ensureGroupPrincipalExists = async function (principal, authContext = null) {
  if (principal.type !== PrincipalType.GROUP) {
    throw new Error(`Invalid principal type: ${principal.type}. Expected '${PrincipalType.GROUP}'`);
  }

  if (principal.id && principal.source !== 'entra') {
    return await ensureLocalGroupPrincipalExists(principal.id);
  }

  if (principal.source === 'entra') {
    if (!principal.name || !principal.idOnTheSource) {
      throw new Error('Entra ID group principals must have name and idOnTheSource');
    }

    let memberIds = [];
    if (authContext && authContext.accessToken && authContext.sub) {
      try {
        memberIds = await getGroupMembers(
          authContext.accessToken,
          authContext.sub,
          principal.idOnTheSource,
        );

        // Include group owners as members if feature is enabled
        if (isEnabled(process.env.ENTRA_ID_INCLUDE_OWNERS_AS_MEMBERS)) {
          const ownerIds = await getGroupOwners(
            authContext.accessToken,
            authContext.sub,
            principal.idOnTheSource,
          );
          if (ownerIds && ownerIds.length > 0) {
            memberIds.push(...ownerIds);
            // Remove duplicates
            memberIds = [...new Set(memberIds)];
          }
        }
      } catch (error) {
        logger.error('Failed to fetch group members from Graph API:', error);
      }
    }

    let existingGroup = await db.findGroupByExternalId(principal.idOnTheSource, 'entra');

    if (!existingGroup && principal.email) {
      existingGroup = await db.findGroupByQuery({ email: principal.email.toLowerCase() });
    }

    if (existingGroup) {
      const updateData = {};
      let needsUpdate = false;

      if (!existingGroup.idOnTheSource && principal.idOnTheSource) {
        updateData.idOnTheSource = principal.idOnTheSource;
        updateData.source = 'entra';
        needsUpdate = true;
      }

      if (principal.description && existingGroup.description !== principal.description) {
        updateData.description = principal.description;
        needsUpdate = true;
      }

      if (principal.email && existingGroup.email !== principal.email.toLowerCase()) {
        updateData.email = principal.email.toLowerCase();
        needsUpdate = true;
      }

      if (authContext && authContext.accessToken && authContext.sub) {
        updateData.memberIds = memberIds;
        needsUpdate = true;
      }

      if (needsUpdate) {
        await db.updateGroupById(existingGroup._id, updateData);
      }

      return existingGroup._id.toString();
    }

    const groupData = {
      name: principal.name,
      source: 'entra',
      idOnTheSource: principal.idOnTheSource,
      memberIds: memberIds, // Store idOnTheSource values of group members (empty if no auth context)
    };

    if (principal.email) {
      groupData.email = principal.email.toLowerCase();
    }

    if (principal.description) {
      groupData.description = principal.description;
    }

    const newGroup = await db.createGroup(groupData);
    return newGroup._id.toString();
  }
  if (principal.id && authContext == null) {
    return principal.id;
  }

  throw new Error(`Unsupported group principal source: ${principal.source}`);
};

/**
 * Sync user's Entra ID group memberships with auto-creation of missing groups
 * Optimized approach:
 * 1. Get all group IDs user should be member of from Entra
 * 2. Try to add user to existing groups (fast, no Graph API calls)
 * 3. Query DB to identify which groups don't exist (indexed query, fast)
 * 4. For missing groups only, fetch details from Graph API in batches
 * 5. Upsert missing groups using upsertGroupByExternalId (race-safe)
 * 6. Add user to newly created/upserted groups via bulkUpdate
 * 7. Remove user from groups they're no longer member of
 *
 * @param {Object} user - User object with authentication context
 * @param {string} user.openidId - User's OpenID subject identifier
 * @param {string} user.idOnTheSource - User's Entra ID (oid from token claims)
 * @param {string} user.provider - Authentication provider ('openid')
 * @param {string} accessToken - Access token for Graph API calls
 * @param {mongoose.ClientSession} [session] - Optional MongoDB session for transactions
 * @returns {Promise<void>}
 */
const syncUserEntraGroupMemberships = async (user, accessToken, session = null) => {
  const tenantId = user?.tenantId ? String(user.tenantId) : undefined;
  if (!tenantId || getTenantId() != null) {
    return performEntraGroupMembershipSync(user, accessToken, session);
  }
  /**
   * The OAuth callback runs before `tenantContextMiddleware`, so establish the
   * user's tenant context here: group queries, created groups, and principal
   * cache invalidation are then scoped exactly like authenticated reads.
   */
  return tenantStorage.run({ tenantId, userId: user._id?.toString() }, async () =>
    performEntraGroupMembershipSync(user, accessToken, session),
  );
};

const performEntraGroupMembershipSync = async (user, accessToken, session = null) => {
  try {
    if (!entraIdPrincipalFeatureEnabled(user) || !accessToken || !user.idOnTheSource) {
      return;
    }

    // Step 1: Get all group IDs user should be member of
    const memberGroupIds = await getUserEntraGroups(accessToken, user.openidId);
    let allGroupIds = [...(memberGroupIds || [])];

    // Include owned groups if feature is enabled
    if (isEnabled(process.env.ENTRA_ID_INCLUDE_OWNERS_AS_MEMBERS)) {
      const ownedGroupIds = await getUserOwnedEntraGroups(accessToken, user.openidId);
      if (ownedGroupIds && ownedGroupIds.length > 0) {
        allGroupIds.push(...ownedGroupIds);
        // Remove duplicates
        allGroupIds = [...new Set(allGroupIds)];
      }
    }

    const sessionOptions = session ? { session } : {};

    // Early return if no groups found (protects against temporary API failures)
    if (allGroupIds.length === 0) {
      logger.debug(
        `[PermissionService.syncUserEntraGroupMemberships] No groups found for user ${user._id}`,
      );
      return;
    }

    logger.info(
      `[PermissionService.syncUserEntraGroupMemberships] Syncing ${allGroupIds.length} groups for user ${user._id}`,
    );

    // Step 2: Try to add user to existing groups (fast operation)
    const addResult = await db.bulkUpdateGroups(
      {
        idOnTheSource: { $in: allGroupIds },
        source: 'entra',
        memberIds: { $ne: user.idOnTheSource },
      },
      { $addToSet: { memberIds: user.idOnTheSource } },
      sessionOptions,
    );

    logger.debug(
      `[PermissionService.syncUserEntraGroupMemberships] Added user to ${addResult.modifiedCount || 0} existing groups`,
    );

    // Step 3: Find which groups don't exist in DB using db layer
    const existingGroups = await db.findGroupsByExternalIds(allGroupIds, 'entra', session);
    const existingGroupIds = new Set(existingGroups.map((g) => g.idOnTheSource));

    const missingGroupIds = allGroupIds.filter((id) => !existingGroupIds.has(id));

    if (missingGroupIds.length > 0) {
      logger.info(
        `[PermissionService.syncUserEntraGroupMemberships] Found ${missingGroupIds.length} groups that don't exist, fetching details...`,
      );

      // Step 4: Fetch details only for missing groups (optimized batch request)
      const groupDetails = await getEntraGroupDetailsBatch(
        accessToken,
        user.openidId,
        missingGroupIds,
      );

      if (groupDetails.length > 0) {
        logger.info(
          `[PermissionService.syncUserEntraGroupMemberships] Creating ${groupDetails.length} new groups`,
        );

        // Step 5: Upsert missing groups (race-safe by design)
        // Use upsertGroupByExternalId for each group to handle concurrent creates gracefully
        const upsertPromises = groupDetails.map((group) =>
          db.upsertGroupByExternalId(
            group.id,
            'entra',
            {
              name: group.name,
              email: group.email,
              description: group.description,
            },
            session,
          ),
        );

        await Promise.all(upsertPromises);

        // Step 6: Add user to all newly created/upserted groups
        await db.bulkUpdateGroups(
          {
            idOnTheSource: { $in: missingGroupIds },
            source: 'entra',
            memberIds: { $ne: user.idOnTheSource },
          },
          { $addToSet: { memberIds: user.idOnTheSource } },
          sessionOptions,
        );

        logger.info(
          `[PermissionService.syncUserEntraGroupMemberships] Successfully created/updated ${groupDetails.length} groups`,
        );
      } else {
        logger.warn(
          `[PermissionService.syncUserEntraGroupMemberships] Could not fetch details for ${missingGroupIds.length} missing groups`,
        );
      }
    } else {
      logger.debug(
        `[PermissionService.syncUserEntraGroupMemberships] All ${allGroupIds.length} groups already exist in database`,
      );
    }

    // Step 7: Remove user from Entra groups they're no longer member of
    const removeResult = await db.bulkUpdateGroups(
      {
        source: 'entra',
        memberIds: user.idOnTheSource,
        idOnTheSource: { $nin: allGroupIds },
      },
      { $pullAll: { memberIds: [user.idOnTheSource] } },
      sessionOptions,
    );

    logger.debug(
      `[PermissionService.syncUserEntraGroupMemberships] Removed user from ${removeResult.modifiedCount || 0} groups`,
    );

    logger.info(
      `[PermissionService.syncUserEntraGroupMemberships] Successfully synced groups for user ${user._id}`,
    );
  } catch (error) {
    // Log error but don't re-throw: group sync is best-effort operation
    // and should not block authentication even if temporary API/DB issues occur
    logger.error(`[PermissionService.syncUserEntraGroupMemberships] Error syncing groups:`, error);
  }
};

/**
 * Check if public has a specific permission on a resource
 * @param {Object} params - Parameters for checking public permission
 * @param {string} params.resourceType - Type of resource (e.g., 'agent')
 * @param {string|mongoose.Types.ObjectId} params.resourceId - The ID of the resource
 * @param {number} params.requiredPermissions - The permission bits required (e.g., 1 for VIEW, 3 for VIEW+EDIT)
 * @returns {Promise<boolean>} Whether public has the required permission bits
 */
const hasPublicPermission = async ({ resourceType, resourceId, requiredPermissions }) => {
  try {
    if (typeof requiredPermissions !== 'number' || requiredPermissions < 1) {
      throw new Error('requiredPermissions must be a positive number');
    }

    validateResourceType(resourceType);

    // Use public principal to check permissions
    const publicPrincipal = [{ principalType: PrincipalType.PUBLIC }];

    const entries = await db.findEntriesByPrincipalsAndResource(
      publicPrincipal,
      resourceType,
      resourceId,
    );

    // Check if any entry has the required permission bits
    return entries.some((entry) => (entry.permBits & requiredPermissions) === requiredPermissions);
  } catch (error) {
    logger.error(`[PermissionService.hasPublicPermission] Error: ${error.message}`);
    // Re-throw validation errors
    if (error.message.includes('requiredPermissions must be')) {
      throw error;
    }
    return false;
  }
};

/** Typed implementation; this legacy module only binds the shared model methods. */
const accessControlService = new AccessControlService(mongoose, db);
const bulkUpdateResourcePermissions = (params) =>
  accessControlService.bulkUpdateResourcePermissions(params);
const restoreInsightsPermissionChanges = (params) =>
  accessControlService.restoreInsightsPermissionChanges(params);

/**
 * Remove all permissions for a resource (cleanup when resource is deleted)
 * @param {Object} params - Parameters for removing all permissions
 * @param {string} params.resourceType - Type of resource (e.g., 'agent', 'prompt')
 * @param {string|mongoose.Types.ObjectId} params.resourceId - The ID of the resource
 * @returns {Promise<Object>} Result of the deletion operation
 */
const removeAllPermissions = async ({ resourceType, resourceId }) => {
  try {
    validateResourceType(resourceType);

    if (!resourceId || !mongoose.Types.ObjectId.isValid(resourceId)) {
      throw new Error(`Invalid resource ID: ${resourceId}`);
    }

    const result = await db.deleteAclEntries({
      resourceType,
      resourceId,
    });

    if (resourceType === ResourceType.PROMPTGROUP) {
      await db.invalidatePromptGroupAccessContext();
    }

    return result;
  } catch (error) {
    logger.error(`[PermissionService.removeAllPermissions] Error: ${error.message}`);
    throw error;
  }
};

module.exports = {
  grantPermission,
  checkPermission,
  getEffectivePermissions,
  getResourcePermissionsMap,
  findAccessibleResources,
  findPubliclyAccessibleResources,
  hasPublicPermission,
  getAvailableRoles,
  bulkUpdateResourcePermissions,
  restoreInsightsPermissionChanges,
  ensurePrincipalExists,
  ensureGroupPrincipalExists,
  syncUserEntraGroupMemberships,
  removeAllPermissions,
};

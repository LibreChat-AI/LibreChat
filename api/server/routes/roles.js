const express = require('express');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const {
  SystemRoles,
  roleDefaults,
  PermissionTypes,
  agentPermissionsSchema,
  promptPermissionsSchema,
  memoryPermissionsSchema,
  mcpServersPermissionsSchema,
  marketplacePermissionsSchema,
  peoplePickerPermissionsSchema,
  remoteAgentsPermissionsSchema,
  skillPermissionsSchema,
} = require('librechat-data-provider');
const { hasCapability, requireCapability } = require('~/server/middleware/roles/capabilities');
const { updateRoleByName, getRoleByName } = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();
router.use(requireJwtAuth);
const manageRoles = requireCapability(SystemCapabilities.MANAGE_ROLES);

/**
 * Permission configuration mapping
 * Maps route paths to their corresponding schemas and permission types
 */
const permissionConfigs = {
  prompts: {
    schema: promptPermissionsSchema,
    permissionType: PermissionTypes.PROMPTS,
    errorMessage: 'Invalid prompt permissions.',
  },
  agents: {
    schema: agentPermissionsSchema,
    permissionType: PermissionTypes.AGENTS,
    errorMessage: 'Invalid agent permissions.',
  },
  memories: {
    schema: memoryPermissionsSchema,
    permissionType: PermissionTypes.MEMORIES,
    errorMessage: 'Invalid memory permissions.',
  },
  'people-picker': {
    schema: peoplePickerPermissionsSchema,
    permissionType: PermissionTypes.PEOPLE_PICKER,
    errorMessage: 'Invalid people picker permissions.',
  },
  'mcp-servers': {
    schema: mcpServersPermissionsSchema,
    permissionType: PermissionTypes.MCP_SERVERS,
    errorMessage: 'Invalid MCP servers permissions.',
  },
  marketplace: {
    schema: marketplacePermissionsSchema,
    permissionType: PermissionTypes.MARKETPLACE,
    errorMessage: 'Invalid marketplace permissions.',
  },
  'remote-agents': {
    schema: remoteAgentsPermissionsSchema,
    permissionType: PermissionTypes.REMOTE_AGENTS,
    errorMessage: 'Invalid remote agents permissions.',
  },
  skills: {
    schema: skillPermissionsSchema,
    permissionType: PermissionTypes.SKILLS,
    errorMessage: 'Invalid skill permissions.',
  },
};

/**
 * Generic handler for updating permissions
 * @param {string} permissionKey - The key from permissionConfigs
 * @returns {Function} Express route handler
 */
const createPermissionUpdateHandler = (permissionKey) => {
  const config = permissionConfigs[permissionKey];

  return async (req, res) => {
    const { roleName } = req.params;
    const updates = req.body;

    try {
      const parsedUpdates = config.schema.partial().parse(updates);

      const role = await getRoleByName(roleName);
      if (!role) {
        return res.status(404).send({ message: 'Role not found' });
      }

      const currentPermissions =
        role.permissions?.[config.permissionType] || role[config.permissionType] || {};

      const mergedUpdates = {
        permissions: {
          ...role.permissions,
          [config.permissionType]: {
            ...currentPermissions,
            ...parsedUpdates,
          },
        },
      };

      const updatedRole = await updateRoleByName(roleName, mergedUpdates);
      res.status(200).send(updatedRole);
    } catch (error) {
      return res.status(400).send({ message: config.errorMessage, error: error.errors });
    }
  };
};

/**
 * GET /api/roles/:roleName
 * Get a specific role by name
 */
router.get('/:roleName', async (req, res) => {
  const { roleName } = req.params;

  try {
    const isOwnRole = req.user?.role === roleName;
    const isDefaultRole = Object.hasOwn(roleDefaults, roleName);
    /** READ_ROLES only gates reading other roles; own role and non-admin default roles skip the probe */
    const requiresReadRoles = !isOwnRole && (roleName === SystemRoles.ADMIN || !isDefaultRole);
    if (requiresReadRoles) {
      let hasReadRoles = false;
      try {
        hasReadRoles = await hasCapability(
          {
            id: req.user?.id ?? req.user?._id?.toString() ?? '',
            role: req.user?.role ?? '',
            tenantId: req.user?.tenantId,
            idOnTheSource: req.user?.idOnTheSource ?? null,
          },
          SystemCapabilities.READ_ROLES,
        );
      } catch (err) {
        logger.warn(`[GET /roles/:roleName] capability check failed: ${err.message}`);
      }
      if (!hasReadRoles) {
        return res.status(403).send({ message: 'Unauthorized' });
      }
    }

    const role = await getRoleByName(roleName, '-_id -__v');
    if (!role) {
      return res.status(404).send({ message: 'Role not found' });
    }

    res.status(200).send(role);
  } catch (error) {
    logger.error('[GET /roles/:roleName] Error:', error);
    return res.status(500).send({ message: 'Failed to retrieve role' });
  }
});

/**
 * PUT /api/roles/:roleName/prompts
 * Update prompt permissions for a specific role
 */
router.put('/:roleName/prompts', manageRoles, createPermissionUpdateHandler('prompts'));

/**
 * PUT /api/roles/:roleName/agents
 * Update agent permissions for a specific role
 */
router.put('/:roleName/agents', manageRoles, createPermissionUpdateHandler('agents'));

/**
 * PUT /api/roles/:roleName/memories
 * Update memory permissions for a specific role
 */
router.put('/:roleName/memories', manageRoles, createPermissionUpdateHandler('memories'));

/**
 * PUT /api/roles/:roleName/people-picker
 * Update people picker permissions for a specific role
 */
router.put('/:roleName/people-picker', manageRoles, createPermissionUpdateHandler('people-picker'));

/**
 * PUT /api/roles/:roleName/mcp-servers
 * Update MCP servers permissions for a specific role
 */
router.put('/:roleName/mcp-servers', manageRoles, createPermissionUpdateHandler('mcp-servers'));

/**
 * PUT /api/roles/:roleName/marketplace
 * Update marketplace permissions for a specific role
 */
router.put('/:roleName/marketplace', manageRoles, createPermissionUpdateHandler('marketplace'));

/**
 * PUT /api/roles/:roleName/remote-agents
 * Update remote agents (API) permissions for a specific role
 */
router.put('/:roleName/remote-agents', manageRoles, createPermissionUpdateHandler('remote-agents'));

/**
 * PUT /api/roles/:roleName/skills
 * Update skill permissions for a specific role
 */
router.put('/:roleName/skills', manageRoles, createPermissionUpdateHandler('skills'));

module.exports = router;

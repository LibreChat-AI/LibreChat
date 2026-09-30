const express = require('express');
const { ObjectId } = require('mongodb');
const { logger, isValidObjectIdString } = require('@librechat/data-schemas');
const {
  generateCheckAccess,
  markPublicPromptGroups,
  buildPromptGroupFilter,
  formatPromptGroupsResponse,
  safeValidatePromptGroupUpdate,
  safeValidatePromptGroupCategory,
  createEmptyPromptGroupsResponse,
  filterAccessibleIdsBySharedLogic,
  inspectPromptContent,
  projectStoredPrompts,
  projectStoredPromptGroup,
  projectStoredPromptGroups,
  contentFilterBlockResponse,
} = require('@librechat/api');
const {
  Permissions,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionBits,
  PermissionTypes,
} = require('librechat-data-provider');
const { SystemCapabilities } = require('@librechat/data-schemas');
const {
  getListPromptGroupsByAccess,
  getPromptGroupAccessContext,
  incrementPromptGroupUsage,
  makePromptProduction,
  updatePromptGroup,
  deletePromptGroup,
  createPromptGroup,
  getPromptGroup,
  getRoleByName,
  deletePrompt,
  getPrompts,
  savePrompt,
  getPrompt,
} = require('~/models');
const {
  canAccessPromptGroupResource,
  canAccessPromptViaGroup,
  promptUsageLimiter,
  requireJwtAuth,
  configMiddleware,
} = require('~/server/middleware');
const { getEffectivePermissions, grantPermission } = require('~/server/services/PermissionService');
const { hasCapability } = require('~/server/middleware/roles/capabilities');

const router = express.Router();

const blockFilteredPromptContent = (req, res, promptData) => {
  const finding = inspectPromptContent(promptData, req.config?.filters);
  if (finding == null) {
    return false;
  }
  res.status(400).json(contentFilterBlockResponse(finding));
  return true;
};

const checkPromptAccess = generateCheckAccess({
  permissionType: PermissionTypes.PROMPTS,
  permissions: [Permissions.USE],
  getRoleByName,
});
const checkPromptCreate = generateCheckAccess({
  permissionType: PermissionTypes.PROMPTS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});

router.use(requireJwtAuth);
router.use(checkPromptAccess);

const checkGlobalPromptShare = generateCheckAccess({
  permissionType: PermissionTypes.PROMPTS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});

/**
 * Route to get single prompt group by its ID
 * GET /groups/:groupId
 */
router.get(
  '/groups/:groupId',
  canAccessPromptGroupResource({
    requiredPermission: PermissionBits.VIEW,
  }),
  configMiddleware,
  async (req, res) => {
    const { groupId } = req.params;

    try {
      const group = await getPromptGroup({ _id: groupId });

      if (!group) {
        return res.status(404).send({ message: 'Prompt group not found' });
      }

      if (blockFilteredPromptContent(req, res, { group })) {
        return;
      }

      res.status(200).send(projectStoredPromptGroup(group, req.config?.filters));
    } catch (error) {
      logger.error('Error getting prompt group', error);
      res.status(500).send({ message: 'Error getting prompt group' });
    }
  },
);

/**
 * Route to fetch all prompt groups (ACL-aware)
 * GET /all
 */
router.get('/all', configMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, category } = req.query;
    const { filter, searchShared, searchSharedOnly } = buildPromptGroupFilter({
      name,
      category,
    });

    const { accessibleIds, publiclyAccessibleIds, ownedPromptGroupIds } =
      await getPromptGroupAccessContext({ userId, role: req.user.role });

    const filteredAccessibleIds = await filterAccessibleIdsBySharedLogic({
      accessibleIds,
      searchShared,
      searchSharedOnly,
      publicPromptGroupIds: publiclyAccessibleIds,
      ownedPromptGroupIds,
    });

    const result = await getListPromptGroupsByAccess({
      accessibleIds: filteredAccessibleIds,
      otherParams: filter,
    });

    if (!result) {
      return res.status(200).send([]);
    }

    const { data: promptGroups = [] } = result;
    if (!promptGroups.length) {
      return res.status(200).send([]);
    }

    const readablePromptGroups = projectStoredPromptGroups(promptGroups, req.config?.filters, {
      forReuse: true,
    });
    const groupsWithPublicFlag = markPublicPromptGroups(
      readablePromptGroups,
      publiclyAccessibleIds,
    );
    res.status(200).send(groupsWithPublicFlag);
  } catch (error) {
    logger.error(error);
    res.status(500).send({ error: 'Error getting prompt groups' });
  }
});

/**
 * Route to fetch paginated prompt groups with filters (ACL-aware)
 * GET /groups
 */
router.get('/groups', configMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { pageSize, limit, cursor, name, category } = req.query;

    const { filter, searchShared, searchSharedOnly } = buildPromptGroupFilter({
      name,
      category,
    });

    let actualLimit = limit;
    let actualCursor = cursor;

    if (pageSize && !limit) {
      actualLimit = parseInt(pageSize, 10);
    }

    if (
      actualCursor &&
      (actualCursor === 'undefined' || actualCursor === 'null' || actualCursor.length === 0)
    ) {
      actualCursor = null;
    }

    const { accessibleIds, publiclyAccessibleIds, ownedPromptGroupIds } =
      await getPromptGroupAccessContext({ userId, role: req.user.role });

    const filteredAccessibleIds = await filterAccessibleIdsBySharedLogic({
      accessibleIds,
      searchShared,
      searchSharedOnly,
      publicPromptGroupIds: publiclyAccessibleIds,
      ownedPromptGroupIds,
    });

    // Cursor-based pagination only
    const result = await getListPromptGroupsByAccess({
      accessibleIds: filteredAccessibleIds,
      otherParams: filter,
      limit: actualLimit,
      after: actualCursor,
    });

    if (!result) {
      const emptyResponse = createEmptyPromptGroupsResponse({
        pageNumber: '1',
        pageSize: actualLimit,
        actualLimit,
      });
      return res.status(200).send(emptyResponse);
    }

    const { data: promptGroups = [], has_more = false, after = null } = result;
    const readablePromptGroups = projectStoredPromptGroups(promptGroups, req.config?.filters);
    const groupsWithPublicFlag = markPublicPromptGroups(
      readablePromptGroups,
      publiclyAccessibleIds,
    );

    const response = formatPromptGroupsResponse({
      promptGroups: groupsWithPublicFlag,
      pageNumber: '1', // Always 1 for cursor-based pagination
      pageSize: actualLimit.toString(),
      hasMore: has_more,
      after,
    });

    res.status(200).send(response);
  } catch (error) {
    logger.error(error);
    res.status(500).send({ error: 'Error getting prompt groups' });
  }
});

/**
 * Creates a new prompt group with initial prompt
 * @param {object} req
 * @param {TCreatePrompt} req.body
 * @param {Express.Response} res
 */
const createNewPromptGroup = async (req, res) => {
  try {
    const { prompt, group } = req.body;

    if (!prompt || !group || !group.name) {
      return res.status(400).send({ error: 'Prompt and group name are required' });
    }

    if (group.category !== undefined) {
      const categoryResult = safeValidatePromptGroupCategory(group.category);
      if (!categoryResult.success) {
        return res.status(400).send({
          error: 'Invalid request body',
          details: categoryResult.error.errors,
        });
      }
      group.category = categoryResult.data;
    }

    if (blockFilteredPromptContent(req, res, { prompt, group })) {
      return;
    }

    const saveData = {
      prompt,
      group,
      author: req.user.id,
      authorName: req.user.name,
    };

    const result = await createPromptGroup(saveData);

    if (result.prompt && result.prompt._id && result.prompt.groupId) {
      try {
        await grantPermission({
          principalType: PrincipalType.USER,
          principalId: req.user.id,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId: result.prompt.groupId,
          accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
          grantedBy: req.user.id,
        });
        logger.debug(
          `[createPromptGroup] Granted owner permissions to user ${req.user.id} for promptGroup ${result.prompt.groupId}`,
        );
      } catch (permissionError) {
        logger.error(
          `[createPromptGroup] Failed to grant owner permissions for promptGroup ${result.prompt.groupId}:`,
          permissionError,
        );
      }
    }

    res.status(200).send(result);
  } catch (error) {
    logger.error(error);
    res.status(500).send({ error: 'Error creating prompt group' });
  }
};

/**
 * Adds a new prompt to an existing prompt group
 * @param {object} req
 * @param {TCreatePrompt} req.body
 * @param {Express.Response} res
 */
const addPromptToGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).send({ error: 'Prompt is required' });
    }

    if (typeof prompt.prompt !== 'string' || !prompt.prompt.trim()) {
      return res
        .status(400)
        .send({ error: 'Prompt text is required and must be a non-empty string' });
    }

    if (prompt.type !== 'text' && prompt.type !== 'chat') {
      return res.status(400).send({ error: 'Prompt type must be "text" or "chat"' });
    }

    if (blockFilteredPromptContent(req, res, { prompt })) {
      return;
    }

    // Ensure the prompt is associated with the correct group
    prompt.groupId = groupId;

    const saveData = {
      prompt,
      author: req.user.id,
      authorName: req.user.name,
    };

    const result = await savePrompt(saveData);
    res.status(200).send(result);
  } catch (error) {
    logger.error(error);
    res.status(500).send({ error: 'Error adding prompt to group' });
  }
};

// Create new prompt group (requires CREATE permission)
router.post('/', checkPromptCreate, configMiddleware, createNewPromptGroup);

// Add prompt to existing group (requires EDIT permission on the group)
router.post(
  '/groups/:groupId/prompts',
  checkPromptAccess,
  canAccessPromptGroupResource({
    requiredPermission: PermissionBits.EDIT,
  }),
  configMiddleware,
  addPromptToGroup,
);

/**
 * Records a prompt group usage (increments numberOfGenerations)
 * POST /groups/:groupId/use
 */
router.post(
  '/groups/:groupId/use',
  promptUsageLimiter,
  canAccessPromptGroupResource({
    requiredPermission: PermissionBits.VIEW,
  }),
  async (req, res) => {
    try {
      const { groupId } = req.params;
      if (!isValidObjectIdString(groupId)) {
        return res.status(400).send({ error: 'Invalid groupId' });
      }
      const result = await incrementPromptGroupUsage(groupId);
      res.status(200).send(result);
    } catch (error) {
      logger.error('[recordPromptUsage]', error);
      if (error.message === 'Invalid groupId') {
        return res.status(400).send({ error: 'Invalid groupId' });
      }
      if (error.message === 'Prompt group not found') {
        return res.status(404).send({ error: 'Prompt group not found' });
      }
      res.status(500).send({ error: 'Error recording prompt usage' });
    }
  },
);

/**
 * Updates a prompt group
 * @param {object} req
 * @param {object} req.params - The request parameters
 * @param {string} req.params.groupId - The group ID
 * @param {TUpdatePromptGroupPayload} req.body - The request body
 * @param {Express.Response} res
 */
const patchPromptGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    // Don't pass author - permissions are now checked by middleware
    const filter = { _id: groupId };

    const validationResult = safeValidatePromptGroupUpdate(req.body);
    if (!validationResult.success) {
      return res.status(400).send({
        error: 'Invalid request body',
        details: validationResult.error.errors,
      });
    }

    if (blockFilteredPromptContent(req, res, { group: validationResult.data })) {
      return;
    }

    const promptGroup = await updatePromptGroup(filter, validationResult.data);
    res.status(200).send(promptGroup);
  } catch (error) {
    logger.error(error);
    res.status(500).send({ error: 'Error updating prompt group' });
  }
};

router.patch(
  '/groups/:groupId',
  checkGlobalPromptShare,
  canAccessPromptGroupResource({
    requiredPermission: PermissionBits.EDIT,
  }),
  configMiddleware,
  patchPromptGroup,
);

router.patch(
  '/:promptId/tags/production',
  checkPromptCreate,
  canAccessPromptViaGroup({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'promptId',
  }),
  configMiddleware,
  async (req, res) => {
    try {
      const { promptId } = req.params;
      const prompt = await getPrompt({ _id: promptId });
      if (blockFilteredPromptContent(req, res, { prompt })) {
        return;
      }
      const result = await makePromptProduction(promptId);
      res.status(200).send(result);
    } catch (error) {
      logger.error(error);
      res.status(500).send({ error: 'Error updating prompt production' });
    }
  },
);

router.get(
  '/:promptId',
  canAccessPromptViaGroup({
    requiredPermission: PermissionBits.VIEW,
    resourceIdParam: 'promptId',
  }),
  configMiddleware,
  async (req, res) => {
    const { promptId } = req.params;
    const prompt = await getPrompt({ _id: promptId });
    if (blockFilteredPromptContent(req, res, { prompt })) {
      return;
    }
    res.status(200).send(prompt);
  },
);

router.get('/', configMiddleware, async (req, res) => {
  try {
    const author = req.user.id;
    const { groupId } = req.query;

    // If requesting prompts for a specific group, check permissions
    if (groupId) {
      if (!isValidObjectIdString(groupId)) {
        return res.status(400).send({ error: 'Invalid groupId' });
      }

      const permissions = await getEffectivePermissions({
        userId: req.user.id,
        role: req.user.role,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: groupId,
      });

      if (!(permissions & PermissionBits.VIEW)) {
        return res
          .status(403)
          .send({ error: 'Insufficient permissions to view prompts in this group' });
      }

      // If user has access, fetch all prompts in the group (not just their own)
      const prompts = await getPrompts({ groupId: new ObjectId(groupId) });
      const readablePrompts = Array.isArray(prompts)
        ? projectStoredPrompts(prompts, req.config?.filters)
        : prompts;
      return res.status(200).send(readablePrompts);
    }

    // If no groupId, return user's own prompts
    const query = { author };
    let canReadPrompts = false;
    try {
      canReadPrompts = await hasCapability(req.user, SystemCapabilities.READ_PROMPTS);
    } catch (err) {
      logger.warn(`[GET /prompts] capability check failed, denying bypass: ${err.message}`);
    }
    if (canReadPrompts) {
      logger.debug(`[GET /prompts] READ_PROMPTS bypass for user ${req.user.id}`);
      delete query.author;
    }
    const prompts = await getPrompts(query);
    const readablePrompts = Array.isArray(prompts)
      ? projectStoredPrompts(prompts, req.config?.filters)
      : prompts;
    res.status(200).send(readablePrompts);
  } catch (error) {
    logger.error(error);
    res.status(500).send({ error: 'Error getting prompts' });
  }
});

/**
 * Deletes a prompt
 *
 * @param {ServerRequest} req - The request object.
 * @param {TDeletePromptVariables} req.params - The request parameters
 * @param {import('mongoose').ObjectId} req.params.promptId - The prompt ID
 * @param {Express.Response} res - The response object.
 * @return {TDeletePromptResponse} A promise that resolves when the prompt is deleted.
 */
const deletePromptController = async (req, res) => {
  try {
    const { promptId } = req.params;
    const { groupId } = req.query;
    if (!groupId || !isValidObjectIdString(groupId)) {
      return res.status(400).send({ error: 'Invalid or missing groupId' });
    }
    const query = { promptId, groupId };
    const result = await deletePrompt(query);
    res.status(200).send(result);
  } catch (error) {
    logger.error(error);
    res.status(500).send({ error: 'Error deleting prompt' });
  }
};

/**
 * Delete a prompt group
 * @param {ServerRequest} req
 * @param {ServerResponse} res
 * @returns {Promise<TDeletePromptGroupResponse>}
 */
const deletePromptGroupController = async (req, res) => {
  try {
    const { groupId: _id } = req.params;
    // Don't pass author or role - permissions are checked by ACL middleware
    const message = await deletePromptGroup({ _id });
    res.send(message);
  } catch (error) {
    logger.error('Error deleting prompt group', error);
    res.status(500).send({ message: 'Error deleting prompt group' });
  }
};

router.delete(
  '/:promptId',
  checkPromptCreate,
  canAccessPromptViaGroup({
    requiredPermission: PermissionBits.DELETE,
    resourceIdParam: 'promptId',
  }),
  deletePromptController,
);
router.delete(
  '/groups/:groupId',
  checkPromptCreate,
  canAccessPromptGroupResource({
    requiredPermission: PermissionBits.DELETE,
  }),
  deletePromptGroupController,
);

module.exports = router;

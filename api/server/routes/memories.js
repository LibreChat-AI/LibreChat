const express = require('express');
const { isValidMemoryKey } = require('@librechat/data-schemas');
const {
  Tokenizer,
  generateCheckAccess,
  getMemoryAgentIdParam,
  createAgentMemoryPartitionMiddleware,
  blockFilteredMemoryContent,
  projectStoredMemories,
  createMemoryManagementHandlers,
} = require('@librechat/api');
const {
  PermissionTypes,
  PermissionBits,
  ResourceType,
  Permissions,
} = require('librechat-data-provider');
const { checkPermission, findAccessibleResources } = require('~/server/services/PermissionService');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const {
  getAllUserMemories,
  getUserMemories,
  toggleUserMemories,
  getRoleByName,
  createMemory,
  deleteMemory,
  setMemory,
  setMemoryById,
  deleteMemoryById,
  getAgent,
  getAgents,
} = require('~/models');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');

const router = express.Router();

const memoryPayloadLimit = express.json({ limit: '100kb' });

const checkMemoryRead = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.READ],
  getRoleByName,
});
const checkMemoryCreate = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});
const checkMemoryUpdate = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.UPDATE],
  getRoleByName,
});
const checkMemoryDelete = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.UPDATE],
  getRoleByName,
});
const checkMemoryOptOut = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.OPT_OUT],
  getRoleByName,
});
const opaqueMemoryHandlers = createMemoryManagementHandlers({
  setMemoryById,
  deleteMemoryById,
  projectStoredMemories,
  countTokens: (value) => Tokenizer.getTokenCount(value, 'o200k_base'),
});

router.use(requireJwtAuth);

const agentPartitionDependencies = {
  getAgent,
  getRoleByName,
  hasCapability,
  checkPermission,
};
const validateBodyAgentPartition = createAgentMemoryPartitionMiddleware({
  source: 'body',
  ...agentPartitionDependencies,
});
const validateQueryAgentPartition = createAgentMemoryPartitionMiddleware({
  source: 'query',
  ...agentPartitionDependencies,
});
const validateDeletedAgentPartition = createAgentMemoryPartitionMiddleware({
  source: 'query',
  allowMissingAgent: true,
  ...agentPartitionDependencies,
});
const createMemoryMiddleware = [
  memoryPayloadLimit,
  checkMemoryCreate,
  validateBodyAgentPartition,
  configMiddleware,
];
const updateMemoryMiddleware = [
  memoryPayloadLimit,
  checkMemoryUpdate,
  validateQueryAgentPartition,
  configMiddleware,
];

/** Resolves agent display names for agent-partitioned memories, restricted
 *  to agents the requester can VIEW — `agentId` is caller-supplied on write,
 *  so an unrestricted lookup would leak private agents' names. */
const withAgentNames = async (memories, user) => {
  const agentIds = [...new Set(memories.map((m) => m.agentId).filter(Boolean))];
  if (agentIds.length === 0) {
    return memories;
  }
  try {
    const accessibleIds = await findAccessibleResources({
      userId: user.id,
      role: user.role,
      resourceType: ResourceType.AGENT,
      requiredPermissions: PermissionBits.VIEW,
    });
    const agents = await getAgents({ id: { $in: agentIds }, _id: { $in: accessibleIds } });
    const namesById = new Map(agents.map((agent) => [agent.id, agent.name]));
    return memories.map((memory) =>
      memory.agentId
        ? { ...memory, agentName: namesById.get(memory.agentId) ?? undefined }
        : memory,
    );
  } catch (_error) {
    return memories;
  }
};

/**
 * GET /memories
 * Returns all memories for the authenticated user, sorted by updated_at (newest first).
 * Also includes memory usage percentage based on token limit.
 */
router.get('/', checkMemoryRead, configMiddleware, async (req, res) => {
  try {
    const memories = await getAllUserMemories(req.user.id);
    const projectedMemories = projectStoredMemories(memories, req.config?.filters);

    const sortedMemories = (await withAgentNames(projectedMemories, req.user)).sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );

    /** Usage totals reflect the shared personal pool only — `tokenLimit`
     *  applies per partition, matching the inline tools' enforcement. */
    const totalTokens = memories.reduce((sum, memory) => {
      return sum + (memory.agentId ? 0 : memory.tokenCount || 0);
    }, 0);

    const appConfig = req.config;
    const memoryConfig = appConfig?.memory;
    const tokenLimit = memoryConfig?.tokenLimit;
    const charLimit = memoryConfig?.charLimit || 10000;

    let usagePercentage = null;
    if (tokenLimit && tokenLimit > 0) {
      usagePercentage = Math.min(100, Math.round((totalTokens / tokenLimit) * 100));
    }

    res.json({
      memories: sortedMemories,
      totalTokens,
      tokenLimit: tokenLimit || null,
      charLimit,
      usagePercentage,
    });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to retrieve memories.' });
  }
});

/**
 * POST /memories
 * Creates a new memory entry for the authenticated user.
 * Body: { key: string, value: string }
 * Returns 201 and { created: true, memory: <createdDoc> } when successful.
 */
router.post('/', createMemoryMiddleware, async (req, res) => {
  const { key, value } = req.body;
  const agentId = getMemoryAgentIdParam(req.body.agentId);

  if (typeof key !== 'string' || key.trim() === '') {
    return res.status(400).json({ error: 'Key is required and must be a non-empty string.' });
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return res.status(400).json({ error: 'Value is required and must be a non-empty string.' });
  }

  if (!isValidMemoryKey(key.trim())) {
    return res.status(400).json({
      error: 'Key must only contain lowercase letters and underscores.',
    });
  }

  const appConfig = req.config;
  const memoryConfig = appConfig?.memory;
  const charLimit = memoryConfig?.charLimit || 10000;

  if (key.length > 1000) {
    return res.status(400).json({
      error: `Key exceeds maximum length of 1000 characters. Current length: ${key.length} characters.`,
    });
  }

  if (value.length > charLimit) {
    return res.status(400).json({
      error: `Value exceeds maximum length of ${charLimit} characters. Current length: ${value.length} characters.`,
    });
  }

  const normalizedMemory = { key: key.trim(), value: value.trim() };
  if (blockFilteredMemoryContent(req, res, normalizedMemory)) {
    return;
  }

  try {
    const tokenCount = Tokenizer.getTokenCount(value, 'o200k_base');

    const memories = await getUserMemories({ userId: req.user.id, agentId });

    const appConfig = req.config;
    const memoryConfig = appConfig?.memory;
    const tokenLimit = memoryConfig?.tokenLimit;

    if (tokenLimit) {
      const currentTotalTokens = memories.reduce(
        (sum, memory) => sum + (memory.tokenCount || 0),
        0,
      );
      if (currentTotalTokens + tokenCount > tokenLimit) {
        return res.status(400).json({
          error: `Adding this memory would exceed the token limit of ${tokenLimit}. Current usage: ${currentTotalTokens} tokens.`,
        });
      }
    }

    const result = await createMemory({
      userId: req.user.id,
      key: key.trim(),
      value: value.trim(),
      tokenCount,
      agentId,
    });

    if (!result.ok) {
      return res.status(500).json({ error: 'Failed to create memory.' });
    }

    const updatedMemories = await getUserMemories({ userId: req.user.id, agentId });
    const newMemory = updatedMemories.find((m) => m.key === key.trim());

    res.status(201).json({ created: true, memory: newMemory });
  } catch (error) {
    if (error.message && error.message.includes('already exists')) {
      return res.status(409).json({ error: 'Memory with this key already exists.' });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /memories/preferences
 * Updates the user's memory preferences (e.g., enabling/disabling memories).
 * Body: { memories: boolean }
 * Returns 200 and { updated: true, preferences: { memories: boolean } } when successful.
 */
router.patch('/preferences', checkMemoryOptOut, async (req, res) => {
  const { memories } = req.body;

  if (typeof memories !== 'boolean') {
    return res.status(400).json({ error: 'memories must be a boolean value.' });
  }

  try {
    const updatedUser = await toggleUserMemories(req.user.id, memories);

    if (!updatedUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({
      updated: true,
      preferences: {
        memories: updatedUser.personalization?.memories ?? true,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch(
  '/id/:id',
  memoryPayloadLimit,
  checkMemoryUpdate,
  validateQueryAgentPartition,
  configMiddleware,
  opaqueMemoryHandlers.updateById,
);
router.delete(
  '/id/:id',
  checkMemoryDelete,
  validateDeletedAgentPartition,
  opaqueMemoryHandlers.deleteById,
);

/**
 * PATCH /memories/:key
 * Updates the value of an existing memory entry for the authenticated user.
 * Body: { key?: string, value: string }
 * Returns 200 and { updated: true, memory: <updatedDoc> } when successful.
 */
router.patch('/:key', updateMemoryMiddleware, async (req, res) => {
  const { key: urlKey } = req.params;
  const { key: bodyKey, value } = req.body || {};
  const agentId = getMemoryAgentIdParam(req.query.agentId);

  if (typeof value !== 'string' || value.trim() === '') {
    return res.status(400).json({ error: 'Value is required and must be a non-empty string.' });
  }

  if (bodyKey !== undefined && typeof bodyKey !== 'string') {
    return res.status(400).json({ error: 'Key must be a string.' });
  }

  const newKey = bodyKey === undefined ? urlKey : bodyKey.trim();

  if (newKey !== urlKey && !isValidMemoryKey(newKey)) {
    return res.status(400).json({
      error: 'Key must only contain lowercase letters and underscores.',
    });
  }

  const appConfig = req.config;
  const memoryConfig = appConfig?.memory;
  const charLimit = memoryConfig?.charLimit || 10000;

  if (newKey.length > 1000) {
    return res.status(400).json({
      error: `Key exceeds maximum length of 1000 characters. Current length: ${newKey.length} characters.`,
    });
  }

  if (value.length > charLimit) {
    return res.status(400).json({
      error: `Value exceeds maximum length of ${charLimit} characters. Current length: ${value.length} characters.`,
    });
  }

  if (blockFilteredMemoryContent(req, res, { key: newKey, value })) {
    return;
  }

  try {
    const tokenCount = Tokenizer.getTokenCount(value, 'o200k_base');

    const memories = await getUserMemories({ userId: req.user.id, agentId });
    const existingMemory = memories.find((m) => m.key === urlKey);

    if (!existingMemory) {
      return res.status(404).json({ error: 'Memory not found.' });
    }

    if (newKey !== urlKey) {
      const keyExists = memories.find((m) => m.key === newKey);
      if (keyExists) {
        return res.status(409).json({ error: 'Memory with this key already exists.' });
      }

      const createResult = await createMemory({
        userId: req.user.id,
        key: newKey,
        value,
        tokenCount,
        agentId,
      });

      if (!createResult.ok) {
        return res.status(500).json({ error: 'Failed to create new memory.' });
      }

      const deleteResult = await deleteMemory({ userId: req.user.id, key: urlKey, agentId });
      if (!deleteResult.ok) {
        return res.status(500).json({ error: 'Failed to delete old memory.' });
      }
    } else {
      const result = await setMemory({
        userId: req.user.id,
        key: newKey,
        value,
        tokenCount,
        agentId,
      });

      if (!result.ok) {
        return res.status(500).json({ error: 'Failed to update memory.' });
      }
    }

    const updatedMemories = await getUserMemories({ userId: req.user.id, agentId });
    const updatedMemory = updatedMemories.find((m) => m.key === newKey);

    res.json({ updated: true, memory: updatedMemory });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /memories/:key
 * Deletes a memory entry for the authenticated user.
 * Returns 200 and { deleted: true } when successful.
 */
router.delete('/:key', checkMemoryDelete, validateDeletedAgentPartition, async (req, res) => {
  const { key } = req.params;
  const agentId = getMemoryAgentIdParam(req.query.agentId);

  try {
    const result = await deleteMemory({ userId: req.user.id, key, agentId });

    if (!result.ok) {
      return res.status(404).json({ error: 'Memory not found.' });
    }

    res.json({ deleted: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

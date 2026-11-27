const { logger } = require('@librechat/data-schemas');
const {
  PermissionBits,
  ResourceType,
  hasPermissions,
  isEphemeralAgentId,
} = require('librechat-data-provider');
const { getRemoteAgentPermissions } = require('@librechat/api');
const { checkPermission, getEffectivePermissions } = require('~/server/services/PermissionService');
const { getAgent, getFiles } = require('~/models');

const checkAgentPermission = async ({
  userId,
  role,
  resourceType,
  resourceId,
  requiredPermission,
}) => {
  if (resourceType !== ResourceType.REMOTE_AGENT) {
    return checkPermission({ userId, role, resourceType, resourceId, requiredPermission });
  }

  const permissions = await getRemoteAgentPermissions(
    { getEffectivePermissions },
    userId,
    role,
    resourceId,
  );
  return hasPermissions(permissions, requiredPermission);
};

/**
 * @param {Object} agent - The agent document (lean)
 * @returns {Set<string>} All file IDs attached across all resource types
 */
function getAttachedFileIds(agent) {
  const attachedFileIds = new Set();
  if (agent.tool_resources) {
    for (const resource of Object.values(agent.tool_resources)) {
      if (resource?.file_ids && Array.isArray(resource.file_ids)) {
        for (const fileId of resource.file_ids) {
          attachedFileIds.add(fileId);
        }
      }
    }
  }
  return attachedFileIds;
}

function getFilesById(files) {
  const filesById = new Map();
  for (const file of files ?? []) {
    if (file?.file_id) {
      filesById.set(file.file_id, file);
    }
  }
  return filesById;
}

/**
 * Checks if a user has access to multiple files through a shared agent (batch operation).
 * Access is scoped to files attached to the agent with valid file metadata.
 * @param {Object} params - Parameters object
 * @param {string} params.userId - The user ID to check access for
 * @param {string} [params.role] - Optional user role to avoid DB query
 * @param {string[]} params.fileIds - Array of file IDs to check
 * @param {string} params.agentId - The agent ID that might grant access
 * @param {string} [params.resourceType=ResourceType.AGENT] - Agent permission resource type
 * @param {boolean} [params.isDelete] - Whether the operation is a delete operation
 * @param {Array<{ file_id: string, user: string }>} [params.files] - Pre-fetched file documents
 * @returns {Promise<Map<string, boolean>>} Map of fileId to access status
 */
const hasAccessToFilesViaAgent = async ({
  userId,
  role,
  fileIds,
  agentId,
  resourceType = ResourceType.AGENT,
  isDelete,
  files,
}) => {
  const accessMap = new Map();

  fileIds.forEach((fileId) => accessMap.set(fileId, false));

  try {
    const agent = await getAgent({ id: agentId });

    if (!agent) {
      return accessMap;
    }

    const attachedFileIds = getAttachedFileIds(agent);
    const agentAuthorId = agent.author?.toString();
    const filesById =
      files != null
        ? getFilesById(files)
        : getFilesById(
            await getFiles({ file_id: { $in: fileIds } }, null, { file_id: 1, user: 1 }),
          );
    const canInheritFromAgent = (fileId) =>
      attachedFileIds.has(fileId) && filesById.get(fileId)?.user != null;

    if (agentAuthorId === userId.toString()) {
      fileIds.forEach((fileId) => {
        if (canInheritFromAgent(fileId)) {
          accessMap.set(fileId, true);
        }
      });
      return accessMap;
    }

    const hasViewPermission = await checkAgentPermission({
      userId,
      role,
      resourceType,
      resourceId: agent._id,
      requiredPermission: PermissionBits.VIEW,
    });

    if (!hasViewPermission) {
      return accessMap;
    }

    if (isDelete) {
      const hasEditPermission = await checkAgentPermission({
        userId,
        role,
        resourceType,
        resourceId: agent._id,
        requiredPermission: PermissionBits.EDIT,
      });

      if (!hasEditPermission) {
        return accessMap;
      }
    }

    fileIds.forEach((fileId) => {
      if (canInheritFromAgent(fileId)) {
        accessMap.set(fileId, true);
      }
    });

    return accessMap;
  } catch (error) {
    logger.error('[hasAccessToFilesViaAgent] Error checking file access:', error);
    return accessMap;
  }
};

/**
 * Filter files based on user access through agents
 * @param {Object} params - Parameters object
 * @param {Array<MongoFile>} params.files - Array of file documents
 * @param {string} params.userId - User ID for access control
 * @param {string} [params.role] - Optional user role to avoid DB query
 * @param {string} params.agentId - Agent ID that might grant access to files
 * @param {string} [params.resourceType=ResourceType.AGENT] - Agent permission resource type
 * @returns {Promise<Array<MongoFile>>} Filtered array of accessible files
 */
const filterFilesByAgentAccess = async ({
  files,
  userId,
  role,
  agentId,
  resourceType = ResourceType.AGENT,
}) => {
  if (!userId || !agentId || !files || files.length === 0 || isEphemeralAgentId(agentId)) {
    return files;
  }

  // Separate owned files from files that need access check
  const filesToCheck = [];
  const ownedFiles = [];

  for (const file of files) {
    if (file.user && file.user.toString() === userId.toString()) {
      ownedFiles.push(file);
    } else {
      filesToCheck.push(file);
    }
  }

  if (filesToCheck.length === 0) {
    return ownedFiles;
  }

  // Batch check access for all non-owned files
  const fileIds = filesToCheck.map((f) => f.file_id);
  const accessMap = await hasAccessToFilesViaAgent({
    userId,
    role,
    fileIds,
    agentId,
    resourceType,
    files: filesToCheck,
  });

  // Filter files based on access
  const accessibleFiles = filesToCheck.filter((file) => accessMap.get(file.file_id));

  return [...ownedFiles, ...accessibleFiles];
};

module.exports = {
  hasAccessToFilesViaAgent,
  filterFilesByAgentAccess,
};

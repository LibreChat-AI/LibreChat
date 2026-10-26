const express = require('express');
const mongoose = require('mongoose');
const {
  GenerationJobManager,
  openCheckpointDeletion,
  deleteAllSharedLinksWithCleanup,
  createErasureResolver,
  createAdminUsersHandlers,
  revokeUserCodeEnvironmentWorkers,
} = require('@librechat/api');
const { SystemCapabilities, runAsSystem, tenantStorage } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const {
  drainAgentTriggerDeliveriesForUser,
  prepareAgentTriggerUserPurge,
  cancelAgentTriggerUserPurge,
  purgeAgentTriggerDeliveriesForUser,
} = require('~/server/services/Agents/triggers');
const { processDeleteRequest } = require('~/server/services/Files/process');
const { invalidateCachedTools } = require('~/server/services/Config/getCachedTools');
const { getMCPManager, getMCPServersRegistry } = require('~/config');
const { maybeUninstallOAuthMCP } = require('~/server/services/MCP/oauthCleanup');
const subagentThreadTaskStore = require('~/server/services/Endpoints/agents/subagentThreadStore');
const {
  quiesceUserSchedules,
  restoreUserSchedulesFromDeletion,
} = require('~/server/services/Schedules');
const db = require('~/models');
const {
  getAppConfig,
  invalidateConfigCaches,
  invalidateCodeEnvironmentConfigCache,
} = require('~/server/services/Config');

const router = express.Router();

const resolveErasure = createErasureResolver({
  withTenant: (tenantId, operation) =>
    tenantId ? tenantStorage.run({ tenantId }, operation) : runAsSystem(operation),
  db,
  getAppConfig,
  getMCPManager,
  processDeleteRequest,
  invalidateCachedTools,
  mcpOAuth: {
    getRegistry: getMCPServersRegistry,
    getUserPrincipals: db.getUserPrincipals,
    uninstallOAuthMCP: maybeUninstallOAuthMCP,
  },
  openCheckpointDeletion,
  deleteSharedLinks: (userId) => deleteAllSharedLinksWithCleanup(userId, { awaitCleanup: true }),
});

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsers = requireCapability(SystemCapabilities.READ_USERS);
// const requireManageUsers = requireCapability(SystemCapabilities.MANAGE_USERS);

const handlers = createAdminUsersHandlers({
  findUsers: db.findUsers,
  countUsers: db.countUsers,
  beginAgentTriggerUserDeletion: db.beginAgentTriggerUserDeletion,
  cancelAgentTriggerUserDeletion: db.cancelAgentTriggerUserDeletion,
  drainAgentTriggerDeliveriesForUser,
  prepareAgentTriggerUserPurge,
  cancelAgentTriggerUserPurge,
  purgeAgentTriggerDeliveriesForUser,
  revokeUserCodeEnvironmentWorkers: async (userId) =>
    revokeUserCodeEnvironmentWorkers({
      mongoose,
      userId,
      appConfig: await getAppConfig({ baseOnly: true }),
    }),
  deleteUserById: db.deleteUserById,
  deleteUserCodeEnvironments: db.deleteUserCodeEnvironments,
  invalidateCodeEnvironmentConfigCache,
  deleteConfig: db.deleteConfig,
  invalidateConfigCaches,
  deleteAclEntries: db.deleteAclEntries,
  deletePasskeysByUser: db.deletePasskeysByUser,
  resolveErasure,
  cancelSubagentTasks: (userId, tenantId) =>
    subagentThreadTaskStore.cancelAndDrainForOwner(userId, tenantId),
  quiesceUserSchedules,
  restoreUserSchedulesFromDeletion,
  generationJobs: GenerationJobManager,
});

router.use(requireJwtAuth, requireAdminAccess);

router.get('/', requireReadUsers, handlers.listUsers);
router.get('/search', requireReadUsers, handlers.searchUsers);
// router.delete('/:id', requireManageUsers, handlers.deleteUser);

module.exports = router;

const { createLangfusePromptSyncRunner } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { distributedLock } = require('~/cache');
const { grantPermission } = require('~/server/services/PermissionService');
const db = require('~/models');

/** The one Langfuse prompt-sync runner for this process, bound to the shared `distributedLock`. */
const syncLangfusePromptCatalog = createLangfusePromptSyncRunner({
  lock: distributedLock,
  findLangfusePromptGroup: db.findLangfusePromptGroup,
  createLangfusePromptGroup: db.createLangfusePromptGroup,
  deletePromptGroup: db.deletePromptGroup,
  grantPermission,
  logger,
});

module.exports = { syncLangfusePromptCatalog };

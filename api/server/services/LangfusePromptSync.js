const { createLangfusePromptSyncRunner } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { promptService } = require('~/server/services/Prompts');
const { distributedLock } = require('~/cache');

/** The one Langfuse prompt-sync runner for this process, bound to the shared `distributedLock`. */
const syncLangfusePromptCatalog = createLangfusePromptSyncRunner({
  lock: distributedLock,
  promptService,
  logger,
});

module.exports = { syncLangfusePromptCatalog };

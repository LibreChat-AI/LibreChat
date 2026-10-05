const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const { createPromptService, createLinkedInstructionsResolver } = require('@librechat/api');
const { grantPermission } = require('~/server/services/PermissionService');
const { getLogStores } = require('~/cache');
const db = require('~/models');

/**
 * Shared resolver for an agent's `instructionsPrompt` link. Resolve and cache
 * logic lives in `@librechat/api` (`createLinkedInstructionsResolver`); this
 * module wires in the LibreChat prompt service and the
 * `AGENT_LINKED_INSTRUCTIONS` cache namespace (`~/cache/getLogStores.js`).
 */
const linkedInstructionsResolver = createLinkedInstructionsResolver({
  promptService: createPromptService({ db, grantPermission }),
  cache: getLogStores(CacheKeys.AGENT_LINKED_INSTRUCTIONS),
  logger,
});

/** @returns {import('@librechat/api').ResolveLinkedInstructions} */
function getLinkedInstructionsResolver() {
  return linkedInstructionsResolver;
}

module.exports = { getLinkedInstructionsResolver };

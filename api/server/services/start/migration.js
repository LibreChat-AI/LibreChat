const mongoose = require('mongoose');
const { logger, runAsSystem, warnOnMissingSearchTokens } = require('@librechat/data-schemas');
const {
  logAgentMigrationWarning,
  logPromptMigrationWarning,
  checkAgentPermissionsMigration,
  checkPromptPermissionsMigration,
} = require('@librechat/api');
const { findRoleByIdentifier } = require('~/models');

/**
 * Check if permissions migrations are needed for shared resources
 * This runs at the end to ensure all systems are initialized
 */
async function checkMigrations() {
  /** Started first so it overlaps the permission checks; it logs its own failures. */
  const searchTokens = warnOnMissingSearchTokens(mongoose.connection);
  /** Independent reads, so neither check waits on the other. */
  await Promise.all([
    checkAgentPermissionsMigration({
      mongoose,
      methods: {
        findRoleByIdentifier,
      },
      AgentModel: mongoose.models.Agent,
    })
      .then(logAgentMigrationWarning)
      .catch((error) => {
        logger.error('[checkMigrations] Failed to check agent permissions migration:', error);
      }),
    checkPromptPermissionsMigration({
      mongoose,
      methods: {
        findRoleByIdentifier,
      },
      PromptGroupModel: mongoose.models.PromptGroup,
    })
      .then(logPromptMigrationWarning)
      .catch((error) => {
        logger.error('[checkMigrations] Failed to check prompt permissions migration:', error);
      }),
  ]);
  await searchTokens;
}

module.exports = {
  checkMigrations: () => runAsSystem(checkMigrations),
};

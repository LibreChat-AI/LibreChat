const mongoose = require('mongoose');
const {
  logger,
  runAsSystem,
  warnOnMissingSearchTokens,
  migrateLegacyAgentOfficialStatus,
} = require('@librechat/data-schemas');
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
  const migratedOfficialAgents = await migrateLegacyAgentOfficialStatus(mongoose.connection);
  if (migratedOfficialAgents > 0) {
    logger.info(`[AgentOfficialStatusMigration] Updated ${migratedOfficialAgents} agents`);
  }
  try {
    const agentMigrationResult = await checkAgentPermissionsMigration({
      mongoose,
      methods: {
        findRoleByIdentifier,
      },
      AgentModel: mongoose.models.Agent,
    });
    logAgentMigrationWarning(agentMigrationResult);
  } catch (error) {
    logger.error('[checkMigrations] Failed to check agent permissions migration:', error);
  }
  try {
    const promptMigrationResult = await checkPromptPermissionsMigration({
      mongoose,
      methods: {
        findRoleByIdentifier,
      },
      PromptGroupModel: mongoose.models.PromptGroup,
    });
    logPromptMigrationWarning(promptMigrationResult);
  } catch (error) {
    logger.error('[checkMigrations] Failed to check prompt permissions migration:', error);
  }
  await searchTokens;
}

module.exports = {
  checkMigrations: () => runAsSystem(checkMigrations),
};

const mongoose = require('mongoose');
const {
  logger,
  runAsSystem,
  warnOnMissingSearchTokens,
  migrateLegacyAgentOfficialStatus,
} = require('@librechat/data-schemas');
const {
  checkStartupMigrations,
  checkAgentPermissionsMigration,
  checkPromptPermissionsMigration,
} = require('@librechat/api');
const { findRoleByIdentifier } = require('~/models');

/**
 * Check if permissions migrations are needed for shared resources
 * This runs at the end to ensure all systems are initialized
 */
const checkMigrations = () =>
  Promise.all([
    checkStartupMigrations({
      probeSearchTokens: () => warnOnMissingSearchTokens(mongoose.connection),
      checkAgentPermissions: () =>
        checkAgentPermissionsMigration({
          mongoose,
          methods: { findRoleByIdentifier },
          AgentModel: mongoose.models.Agent,
        }),
      checkPromptPermissions: () =>
        checkPromptPermissionsMigration({
          mongoose,
          methods: { findRoleByIdentifier },
          PromptGroupModel: mongoose.models.PromptGroup,
        }),
    }),
    migrateLegacyAgentOfficialStatus(mongoose.connection).then((migratedCount) => {
      if (migratedCount > 0) {
        logger.info(`[AgentOfficialStatusMigration] Updated ${migratedCount} agents`);
      }
    }),
  ]).then(() => undefined);

module.exports = {
  checkMigrations: () => runAsSystem(checkMigrations),
};

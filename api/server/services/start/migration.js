const mongoose = require('mongoose');
const { runAsSystem, warnOnMissingSearchTokens } = require('@librechat/data-schemas');
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
  });

module.exports = {
  checkMigrations: () => runAsSystem(checkMigrations),
};

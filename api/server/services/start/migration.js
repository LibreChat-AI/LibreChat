const mongoose = require('mongoose');
const { runAsSystem } = require('@librechat/data-schemas');
const { checkStartupMigrations } = require('@librechat/api');
const { findRoleByIdentifier } = require('~/models');

/**
 * Check if permissions migrations are needed for shared resources
 * This runs at the end to ensure all systems are initialized
 */
const checkMigrations = () =>
  checkStartupMigrations({
    mongoose,
    methods: { findRoleByIdentifier },
    AgentModel: mongoose.models.Agent,
    PromptGroupModel: mongoose.models.PromptGroup,
  });

module.exports = {
  checkMigrations: () => runAsSystem(checkMigrations),
};

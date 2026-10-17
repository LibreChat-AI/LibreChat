const {
  logger,
  runAsSystem,
  createSkillDeletionPersistenceAdapter,
} = require('@librechat/data-schemas');
const { createSkillDeletionService } = require('@librechat/api');
const db = require('~/models');
const { getAppConfig } = require('~/server/services/Config');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');

const service = createSkillDeletionService({
  persistence: { ...db, ...createSkillDeletionPersistenceAdapter(db) },
  loadConfig: () => getAppConfig({ baseOnly: true }),
  getStrategyFunctions,
  runAsSystem,
  logger,
});

module.exports = service;

const mongoose = require('mongoose');
const { createMethods } = require('@librechat/data-schemas');
const {
  matchModelName,
  findMatchingPattern,
  isDeploymentSkillId,
  createMessageBudgetReader,
  createStorageConfigReader,
} = require('@librechat/api');
const getLogStores = require('~/cache/getLogStores');

const messageBudget = createMessageBudgetReader();
const storageConfig = createStorageConfigReader();

const methods = createMethods(mongoose, {
  matchModelName,
  findMatchingPattern,
  isExternalSkillId: isDeploymentSkillId,
  getCache: getLogStores,
  getChannelStorageConfig: storageConfig.getChannelConfig,
  getMCPAppMessageBudget: messageBudget.getBudget,
});

const seedDatabase = async () => {
  await methods.initializeRoles();
  await methods.seedDefaultRoles();
  await methods.ensureDefaultCategories();
  await methods.seedSystemGrants();
};

module.exports = {
  ...methods,
  initializeMessageBudget: messageBudget.initialize,
  initializeStorageConfig: storageConfig.initialize,
  getDurableStorageConfig: storageConfig.getDurableConfig,
  seedDatabase,
};

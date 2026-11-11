const mongoose = require('mongoose');
const {
  createMethods,
  createToolFavoriteMethods,
  createPostgresFavoriteBackend,
} = require('@librechat/data-schemas');
const {
  matchModelName,
  findMatchingPattern,
  isDeploymentSkillId,
  createMessageBudgetReader,
  createFavoriteRuntime,
  getPersistenceConfig,
} = require('@librechat/api');
const getLogStores = require('~/cache/getLogStores');

const messageBudget = createMessageBudgetReader();

const favorites = createFavoriteRuntime(
  createToolFavoriteMethods(mongoose),
  process.env,
  createPostgresFavoriteBackend,
);

const methods = createMethods(mongoose, {
  toolFavorites: favorites.methods,
  matchModelName,
  findMatchingPattern,
  isExternalSkillId: isDeploymentSkillId,
  getCache: getLogStores,
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
  initializeFavorites: (config) => favorites.initialize(getPersistenceConfig(config)),
  closeFavorites: favorites.close,
  initializeMessageBudget: messageBudget.initialize,
  seedDatabase,
};

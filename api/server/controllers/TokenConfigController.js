const { createTokenConfigController } = require('@librechat/api');
const { getRequestModelsConfig } = require('~/server/controllers/ModelController');
const { getValueKey, getMultiplier, getCacheMultiplier } = require('~/models');

module.exports = createTokenConfigController({
  getRequestModelsConfig,
  getValueKey,
  getMultiplier,
  getCacheMultiplier,
});

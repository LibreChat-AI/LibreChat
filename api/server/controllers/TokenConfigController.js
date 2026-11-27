const { createTokenConfigController, getGoogleBillingConfig } = require('@librechat/api');
const { getRequestModelsConfig } = require('~/server/controllers/ModelController');
const { getValueKey, getMultiplier, getCacheMultiplier } = require('~/models');

module.exports = createTokenConfigController({
  getRequestModelsConfig,
  googleBillingConfig: getGoogleBillingConfig(process.env),
  getValueKey,
  getMultiplier,
  getCacheMultiplier,
});

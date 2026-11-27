const { createModelsService } = require('@librechat/api');
const {
  config,
  getAppConfig,
  loadDefaultModels,
  loadConfigModels,
  loadAsyncEndpoints,
} = require('~/server/services/Config');

module.exports = createModelsService({
  getAppConfig,
  loadDefaultModels,
  loadConfigModels,
  loadAsyncEndpoints,
  defaultEndpointsConfig: config,
});

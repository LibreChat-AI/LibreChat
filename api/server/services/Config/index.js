const appConfig = require('./app');
const mcpToolsCache = require('./mcp');
const { config } = require('./EndpointService');
const getCachedTools = require('./getCachedTools');
const loadCustomConfig = require('./loadCustomConfig');
const loadConfigModels = require('./loadConfigModels');
const getModelsConfig = require('./getModelsConfig');
const loadDefaultModels = require('./loadDefaultModels');
const getEndpointsConfig = require('./getEndpointsConfig');
const loadAsyncEndpoints = require('./loadAsyncEndpoints');

module.exports = {
  config,
  loadCustomConfig,
  loadConfigModels,
  loadDefaultModels,
  getModelsConfig,
  loadAsyncEndpoints,
  ...appConfig,
  ...getCachedTools,
  ...mcpToolsCache,
  ...getEndpointsConfig,
};

const { logger } = require('@librechat/data-schemas');
const { createRemoteModelService, getSafeErrorMetadata } = require('@librechat/api');
const { getEndpointModelsConfig } = require('~/server/controllers/ModelController');
const { getEndpointsConfig, getMCPServerTools } = require('~/server/services/Config');
const { getAccessibleMCPServers } = require('~/server/services/MCP');
const db = require('~/models');

/** Model specs and endpoint models for personal API keys (see `createRemoteModelService`). */
module.exports = createRemoteModelService({
  getEndpointsConfig,
  getEndpointModels: getEndpointModelsConfig,
  getMCPServerTools,
  getAccessibleMCPServers,
  getAgent: db.getAgentWithVersionCount,
  onListError: (error) =>
    logger.warn(
      '[OpenAI API] Listing models only (agents still listed):',
      getSafeErrorMetadata(error),
    ),
});

const { createAgentConversationTitleHandler, GenerationJobManager } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const getLogStores = require('~/cache/getLogStores');
const { saveConvo, getConvo } = require('~/models');

module.exports = createAgentConversationTitleHandler({
  saveConvo,
  getConvo,
  getCache: () => getLogStores(CacheKeys.GEN_TITLE),
  getGenerationEpoch: (id) => GenerationJobManager.getJobStore().getGenerationEpoch(id),
  getEnabledSetting: () => process.env.TITLE_CONVO,
  logger,
});

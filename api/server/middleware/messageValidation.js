const {
  GenerationJobManager,
  createMessageRequestMiddleware,
  isPendingActionStale,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { getConvoOwnership } = require('~/models');

module.exports = createMessageRequestMiddleware({
  getConvo: getConvoOwnership,
  getJob: (conversationId) => GenerationJobManager.getJob(conversationId),
  isPendingActionStale,
  logger,
});

const mongoose = require('mongoose');
const {
  createBackgroundResponsesHost,
  createAgentTriggerProducerBinding,
  checkRemoteAgentAccess,
  GenerationJobManager,
  getSafeErrorMetadata,
} = require('@librechat/api');
const { createResponseStorage, logger } = require('@librechat/data-schemas');
const { getEffectivePermissions } = require('./PermissionService');
const { getAppConfig } = require('./Config');
const db = require('~/models');

const producer = createAgentTriggerProducerBinding();
const dependencies = {
  storage: createResponseStorage(mongoose, { getMCPAppMessageBudget: db.getMCPAppMessageBudget }),
  jobs: GenerationJobManager,
  findUser: (userId) => db.findUser({ _id: userId }),
  getKey: db.getAgentApiKeyById,
  authorizeBinding: (...args) =>
    require('./ChannelAuthority').authorizeChannelResponseKeySource(...args),
  getRole: db.getRoleByName,
  getConfig: (user) =>
    getAppConfig({
      userId: String(user._id),
      tenantId: user.tenantId,
      role: user.role,
      failClosed: true,
    }),
  getAgentPermissions: (agentId, user) =>
    checkRemoteAgentAccess({
      agentId,
      userId: user.id,
      role: user.role,
      getAgent: db.getAgent,
      getEffectivePermissions,
    }).then((result) => result.permissions),
  isPrincipalActive: db.isAgentTriggerPrincipalActive,
  getMessage: db.getMessage,
  getConvoRetention: db.getConvoRetention,
  enqueue: producer.enqueue,
  isQueueReady: producer.isReady,
  signingSecret: () => process.env.JWT_SECRET,
  onError: (error) =>
    logger.error('[Responses background] Operation failed', getSafeErrorMetadata(error)),
};
const host = createBackgroundResponsesHost(dependencies);

module.exports = {
  configureBackgroundResponseQueue: producer.bind,
  readInteractiveReview: host.readInteractiveReview,
  submitInteractiveReview: host.submitInteractiveReview,
  reviewBackgroundResponse: host.review,
  submitBackgroundResponseReview: host.submitReview,
  cancelOwnerBackgroundResponse: host.cancelReview,
  retireBackgroundResponse: host.retireResponse,
  readBackgroundResponse: host.readResponse,
  cancelBackgroundResponse: host.cancelResponse,
  initializeBackgroundResponses: host.initialize,
  backgroundResponseSourceDispatchers: host.sourceDispatchers,
  createBackgroundResponseHandlers: host.handlers,
  authenticateBackgroundResponses: host.authenticate,
};

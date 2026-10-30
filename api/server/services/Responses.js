const mongoose = require('mongoose');
const {
  createBackgroundResponsesHost,
  createBackgroundResponseAuthority,
  createResponseResumeValidation,
  createResponseResumeAdmission,
  checkRemoteAgentAccess,
  getRemoteAgentPermissions,
  getAgentCheckpointer,
  checkAccess,
  reportLocatorTraversalFailure,
  GenerationJobManager,
  getSafeErrorMetadata,
} = require('@librechat/api');
const { createResponseStorage, logger } = require('@librechat/data-schemas');
const { PermissionBits, hasPermissions } = require('librechat-data-provider');
const { getEffectivePermissions } = require('./PermissionService');
const { decryptMetadata } = require('./ActionService');
const { getAppConfig } = require('./Config');
const db = require('~/models');

let enqueueResponse;
const dependencies = {
  storage: createResponseStorage(mongoose, { getMCPAppMessageBudget: db.getMCPAppMessageBudget }),
  jobs: GenerationJobManager,
  publicBaseURL: process.env.DOMAIN_CLIENT,
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
  enqueue: (...args) => enqueueResponse(...args),
  signingSecret: () => process.env.JWT_SECRET,
  onError: (error) =>
    logger.error('[Responses background] Operation failed', getSafeErrorMetadata(error)),
};
const validation = createResponseResumeValidation({
  jobs: GenerationJobManager,
  findUser: dependencies.findUser,
  getConfig: dependencies.getConfig,
  projects: {
    getConvo: db.getConvo,
    getChatProject: db.getChatProject,
    getProjectFiles: db.getProjectFiles,
  },
  content: {
    onTraversalFailure: reportLocatorTraversalFailure,
    getAgentCheckpointer,
    checkAccess,
    getMessages: db.getMessages,
    getFiles: db.getFiles,
    getAgent: db.getAgent,
    getActions: db.getActions,
    getUserMemories: db.getUserMemories,
    getRoleByName: db.getRoleByName,
    decryptMetadata,
    canAccessAgent: (agent, user) =>
      getRemoteAgentPermissions({ getEffectivePermissions }, user.id, user.role, agent._id).then(
        (permissions) => hasPermissions(permissions, PermissionBits.VIEW),
      ),
  },
});
const authority = createBackgroundResponseAuthority(dependencies);
const admitResume = createResponseResumeAdmission({
  storage: dependencies.storage,
  jobs: GenerationJobManager,
  authorize: (record) => authority(record, record.agentId, record.sourceKeyId),
  validate: validation.validateResume,
});
const host = createBackgroundResponsesHost({
  ...dependencies,
  interactive: {
    validate: validation.validateDecision,
    admitResume: (record, _user, intentId) => admitResume(record, record.responseId, intentId),
  },
});

module.exports = {
  readInteractiveReview: host.readInteractiveReview,
  submitInteractiveReview: host.submitInteractiveReview,
  reviewBackgroundResponse: host.review,
  submitBackgroundResponseReview: host.submitReview,
  cancelOwnerBackgroundResponse: host.cancelReview,
  retireBackgroundResponse: host.retireResponse,
  readBackgroundResponse: host.readResponse,
  cancelBackgroundResponse: host.cancelResponse,
  initializeBackgroundResponses: (address, enqueue) => {
    enqueueResponse = enqueue;
    host.initialize(address);
  },
  backgroundResponseSourceDispatchers: host.sourceDispatchers,
  createBackgroundResponseHandlers: host.handlers,
  authenticateBackgroundResponses: host.authenticate,
};

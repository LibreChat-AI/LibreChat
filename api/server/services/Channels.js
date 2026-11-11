const {
  createChannelHandlers,
  verifySlackChannelToken,
  createChannelRunHandlers,
  createChannelExecutionAdapter,
  createChannelResponseProjection,
  createChannelResponseRetirement,
  createChannelIdentityHandlers,
  createChannelFeedbackRuntime,
  sendFeedbackScore,
  getSafeErrorMetadata,
  createChannelArtifactReader,
  createChannelArtifactService,
  createChannelCleanupRuntime,
  createChannelSummaryService,
  createChannelSummaryTraceResolver,
} = require('@librechat/api');
const {
  logger,
  createResponseStorage,
  createChannelFeedbackStorage,
  createChannelSummaryStorage,
} = require('@librechat/data-schemas');
const mongoose = require('mongoose');
const { getHeldCapabilities } = require('~/server/middleware/roles/capabilities');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const db = require('~/models');
const { storage, authority, responseCredentials, policy } = require('./ChannelAuthority');
const {
  readBackgroundResponse,
  cancelBackgroundResponse,
  retireBackgroundResponse,
  readInteractiveReview,
  submitInteractiveReview,
} = require('./Responses');

const responseStorage = createResponseStorage(mongoose, {
  getMCPAppMessageBudget: db.getMCPAppMessageBudget,
});
const getChannelConfig = policy.config;

const handlers = createChannelHandlers({
  db,
  serviceToken: () => process.env.CHANNEL_SERVICE_TOKEN,
  config: policy.requestConfig,
  getAgent: (id) => db.getAgent({ id }),
  deleteApiKey: db.deleteAgentApiKey,
  verifySlackToken: verifySlackChannelToken,
  logError: (metadata) => logger.error('[Channels] Operation failed', metadata),
});

const execution = createChannelExecutionAdapter({
  responseRetirement: createChannelResponseRetirement({
    storage: responseStorage,
    recovery: storage,
    retireResponse: retireBackgroundResponse,
  }),
  responseProjection: createChannelResponseProjection({
    storage: responseStorage,
    readResponse: readBackgroundResponse,
    cancelResponse: cancelBackgroundResponse,
  }),
});
const artifactReader = createChannelArtifactReader({
  getConfig: policy.runConfig,
  getStrategyFunctions,
});
const artifacts = createChannelArtifactService({
  readArtifacts: db.readResponseArtifacts,
  readFile: artifactReader.readFile,
  limits: getChannelConfig,
});
const summary = createChannelSummaryService({
  storage: createChannelSummaryStorage(mongoose),
  trace: createChannelSummaryTraceResolver({
    findUser: (id) => db.findUser({ _id: id }),
    getHeldCapabilities,
    getConfig: policy.traceConfig,
    getMessage: (scope) => db.getMessage(scope),
    getMessages: db.getMessages,
  }),
});
const runs = createChannelRunHandlers({
  interactive: { readInteractiveReview, submitInteractiveReview },
  responseCredential: responseCredentials.provision,
  artifacts,
  storage,
  guard: handlers.service,
  publicBaseUrl: process.env.DOMAIN_CLIENT || 'http://localhost:3080',
  getLeaseMs: async () => (await getChannelConfig()).leaseMs,
  resolvePrincipal: authority.resolvePrincipal,
  advance: execution.advance,
  summarize: summary.summarize,
  retireForAuthorityLoss: execution.retireForAuthorityLoss,
});
const cleanup = createChannelCleanupRuntime({
  storage,
  channels: db,
  resolvePrincipal: authority.resolvePrincipal,
  retireForAuthorityLoss: execution.retireForAuthorityLoss,
  deleteApiKey: db.deleteAgentApiKey,
  isCredentialCurrent: responseCredentials.isCurrent,
  getWorkerSettings: policy.workerSettings,
  onError: (error) =>
    logger.error('[Channels] Cleanup recovery failed', getSafeErrorMetadata(error)),
});
const identityHandlers = createChannelIdentityHandlers({
  identity: authority.identity,
  guard: handlers.service,
});
const feedback = createChannelFeedbackRuntime({
  guard: handlers.service,
  getWorkerSettings: policy.workerSettings,
  hostDeps: {
    channels: db,
    storage: createChannelFeedbackStorage(mongoose),
    getPolicy: policy.feedbackPolicy,
    sendScore: sendFeedbackScore,
  },
  workerDeps: {
    listChannels: db.listAgentChannelTenants,
    onError: (error) =>
      logger.error('[Channels] Feedback recovery failed', getSafeErrorMetadata(error)),
  },
});

module.exports = {
  authorizeChannelResponseKeyRequest: responseCredentials.authorizeRequest,
  authorizeChannelResponseKeySource: responseCredentials.authorizeSource,
  ...handlers,
  runs,
  identityHandlers,
  feedbackHandlers: feedback.handlers,
  initializeChannelFeedback: feedback.initialize,
  stopChannelFeedback: feedback.stop,
  initializeChannelCleanup: cleanup.initialize,
  stopChannelCleanup: cleanup.stop,
  identity: authority.identity,
};

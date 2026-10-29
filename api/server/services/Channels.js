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
const { channelConfigSchema } = require('librechat-data-provider');
const { getAppConfig } = require('~/server/services/Config');
const { getHeldCapabilities } = require('~/server/middleware/roles/capabilities');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const db = require('~/models');
const { storage, authority, responseCredentials } = require('./ChannelAuthority');
const {
  readBackgroundResponse,
  cancelBackgroundResponse,
  retireBackgroundResponse,
  readInteractiveReview,
  submitInteractiveReview,
} = require('./Responses');

const responseStorage = createResponseStorage(mongoose);
const getChannelConfig = async () =>
  channelConfigSchema.parse(
    (await getAppConfig({ baseOnly: true })).endpoints?.agents?.channels ?? {},
  );

const handlers = createChannelHandlers({
  db,
  serviceToken: () => process.env.CHANNEL_SERVICE_TOKEN,
  config: async () => (await getAppConfig({ baseOnly: true })).endpoints?.agents?.channels,
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
  getConfig: (run) =>
    getAppConfig({ tenantId: run.tenantId, userId: run.principal.userId, failClosed: true }),
  getStrategyFunctions,
});
const artifacts = createChannelArtifactService({
  listFiles: db.listRunArtifacts,
  readFile: artifactReader.readFile,
  limits: getChannelConfig,
});
const summary = createChannelSummaryService({
  storage: createChannelSummaryStorage(mongoose),
  trace: createChannelSummaryTraceResolver({
    findUser: (id) => db.findUser({ _id: id }),
    getHeldCapabilities,
    getConfig: async (run) =>
      (
        await getAppConfig({
          tenantId: run.tenantId,
          userId: run.principal.userId,
          failClosed: true,
        })
      ).langfuse,
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
  getConfig: getChannelConfig,
  onError: (error) =>
    logger.error('[Channels] Cleanup recovery failed', getSafeErrorMetadata(error)),
});
const identityHandlers = createChannelIdentityHandlers({
  identity: authority.identity,
  guard: handlers.service,
});
const feedback = createChannelFeedbackRuntime({
  guard: handlers.service,
  runs: storage,
  getConfig: getChannelConfig,
  hostDeps: {
    channels: db,
    storage: createChannelFeedbackStorage(mongoose),
    getAppConfig: (tenantId) => getAppConfig({ tenantId, failClosed: true }),
    getMessage: (filter) => db.getMessage(filter),
    currentTracePolicy: async () => null,
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
  authorizeTrigger: authority.authorizeTrigger,
  authorizeGeneration: authority.authorizeGeneration,
  authorizeResume: authority.authorizeResume,
};

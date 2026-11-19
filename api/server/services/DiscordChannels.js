const mongoose = require('mongoose');
const {
  createDiscordChannelRuntime,
  createDiscordPolicyReader,
  recordDiscordObservation,
  createProxyAwareFetch,
} = require('@librechat/api');
const {
  createDiscordInstallationStorage,
  createDiscordRouteStorage,
  createDiscordInboxStorage,
  createDiscordInboxResolutionStorage,
  createDiscordThreadStorage,
  createDiscordCommandStorage,
  createDiscordGatewayStorage,
  createDiscordRuntimeStorage,
  createDiscordMessageStorage,
  createDiscordDmStorage,
  createChannelIdentityStorage,
  logger,
} = require('@librechat/data-schemas');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { getEffectivePermissions } = require('./PermissionService');
const { getAppConfig } = require('./Config');
const application = require('./ChannelAuthority');
const { recordDiscordFeedback } = require('./Channels');
const db = require('~/models');

const policy = createDiscordPolicyReader(getAppConfig);
module.exports = createDiscordChannelRuntime({
  channels: db,
  observe: recordDiscordObservation,
  installations: createDiscordInstallationStorage(mongoose),
  routes: createDiscordRouteStorage(mongoose),
  inbox: createDiscordInboxStorage(mongoose, policy.inbox),
  inboxResolution: createDiscordInboxResolutionStorage(mongoose),
  threads: createDiscordThreadStorage(mongoose, policy.threads),
  commands: createDiscordCommandStorage(mongoose),
  feedback: { recordDiscordFeedback },
  gateway: createDiscordGatewayStorage(mongoose, policy.ownership),
  discovery: createDiscordRuntimeStorage(mongoose),
  messages: createDiscordMessageStorage(mongoose),
  dm: createDiscordDmStorage(mongoose, policy.dm),
  identities: createChannelIdentityStorage(mongoose),
  application,
  access: { getAgent: db.getAgent, getEffectivePermissions },
  policy,
  serviceToken: () => process.env.CHANNEL_SERVICE_TOKEN,
  publicBaseUrl: process.env.DOMAIN_CLIENT,
  findUser: (id) => db.findUser({ _id: id }),
  isPrincipalActive: db.isAgentTriggerPrincipalActive,
  hasCapability,
  fetch: createProxyAwareFetch(),
  logError: (metadata) => logger.error('[DiscordChannels] Operation failed', metadata),
});

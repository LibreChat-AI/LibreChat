const mongoose = require('mongoose');
const {
  createDiscordChannelRuntime,
  createDiscordPolicyReader,
  createProxyAwareFetch,
} = require('@librechat/api');
const {
  createDiscordInstallationStorage,
  createDiscordRouteStorage,
  createDiscordInboxStorage,
  createDiscordCommandStorage,
  logger,
} = require('@librechat/data-schemas');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { getEffectivePermissions } = require('./PermissionService');
const { getAppConfig } = require('./Config');
const application = require('./ChannelAuthority');
const db = require('~/models');

const policy = createDiscordPolicyReader(getAppConfig);
module.exports = createDiscordChannelRuntime({
  channels: db,
  installations: createDiscordInstallationStorage(mongoose),
  routes: createDiscordRouteStorage(mongoose),
  inbox: createDiscordInboxStorage(mongoose, policy.inbox),
  commands: createDiscordCommandStorage(mongoose),
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

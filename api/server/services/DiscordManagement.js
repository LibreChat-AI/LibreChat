const mongoose = require('mongoose');
const {
  createDiscordManagementRuntime,
  createDiscordManagementSettingsReader,
  createProxyAwareFetch,
} = require('@librechat/api');
const {
  createDiscordInstallationStorage,
  createDiscordInstallStorage,
  createDiscordBrowserSessionStorage,
  logger,
} = require('@librechat/data-schemas');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { getAppConfig } = require('~/server/services/Config');
const db = require('~/models');

module.exports = createDiscordManagementRuntime({
  installations: createDiscordInstallationStorage(mongoose),
  states: createDiscordInstallStorage(mongoose),
  browserSessions: createDiscordBrowserSessionStorage(mongoose),
  readSettings: createDiscordManagementSettingsReader({ readAppConfig: getAppConfig }),
  findUser: (id) => db.findUser({ _id: id }),
  isPrincipalActive: db.isAgentTriggerPrincipalActive,
  hasCapability,
  sessionSecret: process.env.JWT_SECRET,
  publicBaseUrl: process.env.DOMAIN_SERVER,
  clientBaseUrl: process.env.DOMAIN_CLIENT,
  fetch: createProxyAwareFetch(),
  logError: (metadata) => logger.error('[DiscordManagement] Operation failed', metadata),
});

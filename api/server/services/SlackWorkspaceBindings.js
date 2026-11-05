const mongoose = require('mongoose');
const {
  createSlackWorkspaceBindingHandlers,
  createSlackWorkspaceSettingsReader,
  createSlackWorkspaceAdminGuard,
} = require('@librechat/api');
const {
  createSlackWorkspaceStorage,
  createSlackRouteStorage,
  logger,
} = require('@librechat/data-schemas');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { getAppConfig } = require('./Config');
const db = require('~/models');

const readSettings = createSlackWorkspaceSettingsReader({
  storage: createSlackWorkspaceStorage(mongoose),
  readAppConfig: getAppConfig,
  publicBaseUrl: process.env.DOMAIN_SERVER || 'http://localhost:3080',
  clientBaseUrl: process.env.DOMAIN_CLIENT || process.env.DOMAIN_SERVER || 'http://localhost:3080',
});

module.exports = createSlackWorkspaceBindingHandlers({
  channels: db,
  workspaces: createSlackWorkspaceStorage(mongoose),
  routes: createSlackRouteStorage(mongoose, async () => (await readSettings()).channels),
  readSettings,
  isPrincipalActive: db.isAgentTriggerPrincipalActive,
  getAgentName: db.getAgentName,
  canManage: createSlackWorkspaceAdminGuard({
    findUser: (id) => db.findUser({ _id: id }),
    isPrincipalActive: db.isAgentTriggerPrincipalActive,
    hasCapability,
  }),
  logError: (metadata) => logger.error('[SlackWorkspaceBindings] Operation failed', metadata),
});

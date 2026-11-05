const mongoose = require('mongoose');
const {
  createSlackDispatchHandlers,
  createSlackWorkspaceSettingsReader,
  createProxyAwareFetch,
} = require('@librechat/api');
const {
  logger,
  createSlackWorkspaceStorage,
  createSlackRouteStorage,
  createSlackDispatchStorage,
} = require('@librechat/data-schemas');
const db = require('~/models');
const { getAppConfig } = require('./Config');

const readSettings = createSlackWorkspaceSettingsReader({
  storage: createSlackWorkspaceStorage(mongoose),
  readAppConfig: getAppConfig,
  publicBaseUrl: process.env.DOMAIN_SERVER || 'http://localhost:3080',
  clientBaseUrl: process.env.DOMAIN_CLIENT || process.env.DOMAIN_SERVER || 'http://localhost:3080',
});

module.exports = createSlackDispatchHandlers({
  readSettings,
  workspaces: createSlackWorkspaceStorage(mongoose),
  routes: createSlackRouteStorage(mongoose),
  dispatch: createSlackDispatchStorage(mongoose, async () => (await readSettings()).channels),
  channels: db,
  serviceToken: () => process.env.CHANNEL_SERVICE_TOKEN,
  fetch: createProxyAwareFetch(),
  logError: (metadata) => logger.error('[SlackDispatch] Operation failed', metadata),
});

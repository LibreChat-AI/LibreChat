const mongoose = require('mongoose');
const {
  createWatches,
  createConnections,
  createSubscriptions,
} = require('@librechat/data-schemas');
const { createWatchToolHost, createProxyAwareFetch } = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config/app');

// Thin wiring over the TypeScript implementation in packages/api: the `watch` and `unwatch`
// tools a conversation's agent is offered when its owner's subscription allows following.
module.exports = createWatchToolHost({
  getAppConfig,
  env: process.env,
  subscriptions: createSubscriptions(mongoose),
  connections: createConnections(mongoose),
  watches: createWatches(mongoose),
  fetch: createProxyAwareFetch(),
});

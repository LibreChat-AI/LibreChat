const express = require('express');
const mongoose = require('mongoose');
const { createConnections, createSubscriptions } = require('@librechat/data-schemas');
const { createIngressHandler, createProxyAwareFetch } = require('@librechat/api');
const { enqueueAgentTrigger } = require('~/server/services/Agents/triggers');
const { getAppConfig } = require('~/server/services/Config/app');

const router = express.Router();
const subscriptions = createSubscriptions(mongoose);

// Thin wiring over the TypeScript implementation in packages/api: signed deliveries from the
// deployment's event provider apps. No user session; the signature is the authentication.
router.post(
  '/:provider',
  createIngressHandler({
    getAppConfig,
    env: process.env,
    connections: createConnections(mongoose),
    match: subscriptions.match,
    enqueue: enqueueAgentTrigger,
    fetch: createProxyAwareFetch(),
  }),
);

module.exports = router;

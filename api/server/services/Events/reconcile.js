const { createSubscriptionReconciler } = require('@librechat/api');

// Thin wiring over the TypeScript implementation in packages/api: the loop that finishes an
// event subscription's runs nobody else will. The server starts it and stops it on shutdown.
module.exports = createSubscriptionReconciler(require('./subject'));

const { createSharePolicyMiddleware } = require('@librechat/api');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { getRoleByName } = require('~/models');

module.exports = createSharePolicyMiddleware({
  getRoleByName,
  hasCapability,
});

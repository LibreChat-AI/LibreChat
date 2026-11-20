const { logger } = require('@librechat/data-schemas');
const { attachAgentOwnerContacts } = require('@librechat/api');
const db = require('~/models');

const attachOwnerContacts = (agents) =>
  attachAgentOwnerContacts(agents, {
    getFirstOwnerIdsByResource: (resourceType, resourceIds) =>
      db.getFirstOwnerIdsByResource(resourceType, resourceIds),
    findOwnerContactUsers: db.findOwnerContactUsers,
    logger,
  });

module.exports = {
  attachOwnerContacts,
};

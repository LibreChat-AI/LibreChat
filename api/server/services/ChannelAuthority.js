const {
  createChannelApplicationAuthority,
  createChannelApplicationPolicy,
  encryptCredential,
  decryptCredential,
} = require('@librechat/api');
const {
  createChannelIdentityStorage,
  createChannelRunStorage,
  createResponseStorage,
} = require('@librechat/data-schemas');
const mongoose = require('mongoose');
const { getAppConfig } = require('./Config');
const { getEffectivePermissions } = require('./PermissionService');
const db = require('~/models');

module.exports = createChannelApplicationAuthority({
  storage: createChannelRunStorage(mongoose),
  policy: createChannelApplicationPolicy({
    readAppConfig: getAppConfig,
    findUser: db.findUser,
    isPrincipalActive: db.isAgentTriggerPrincipalActive,
  }),
  channels: db,
  identityStorage: createChannelIdentityStorage(mongoose),
  findUser: (id) => db.findUser({ _id: id }),
  getRole: db.getRoleByName,
  isPrincipalActive: db.isAgentTriggerPrincipalActive,
  publicBaseUrl: process.env.DOMAIN_CLIENT || 'http://localhost:3080',
  access: { getAgent: db.getAgent, getEffectivePermissions },
  credentials: {
    encrypt: encryptCredential,
    decrypt: decryptCredential,
    responses: createResponseStorage(mongoose, {
      getMCPAppMessageBudget: db.getMCPAppMessageBudget,
    }),
    createKey: db.createAgentApiKey,
    getKey: db.getAgentApiKeyById,
    deleteKey: db.deleteAgentApiKey,
  },
});

const {
  createChannelAuthority,
  createChannelResponseCredentials,
  encryptCredential,
  decryptCredential,
  checkRemoteAgentAccess,
} = require('@librechat/api');
const {
  createChannelIdentityStorage,
  createChannelRunStorage,
  createResponseStorage,
} = require('@librechat/data-schemas');
const mongoose = require('mongoose');
const { channelConfigSchema } = require('librechat-data-provider');
const { getAppConfig } = require('./Config');
const { getEffectivePermissions } = require('./PermissionService');
const db = require('~/models');

const storage = createChannelRunStorage(mongoose);
const authority = createChannelAuthority({
  channels: { getAgentChannel: db.getAgentChannelMetadata },
  identityStorage: createChannelIdentityStorage(mongoose),
  runs: storage,
  findUser: (id) => db.findUser({ _id: id }),
  getRole: db.getRoleByName,
  isPrincipalActive: db.isAgentTriggerPrincipalActive,
  getAgentPermissions: (agentId, user) =>
    checkRemoteAgentAccess({
      agentId,
      userId: user.id,
      role: user.role,
      getAgent: db.getAgent,
      getEffectivePermissions,
    }).then((result) => result.permissions),
  publicBaseUrl: process.env.DOMAIN_CLIENT || 'http://localhost:3080',
  getLifetimes: async () =>
    channelConfigSchema.parse(
      (await getAppConfig({ baseOnly: true })).endpoints?.agents?.channels ?? {},
    ),
});
const responseCredentials = createChannelResponseCredentials({
  encrypt: encryptCredential,
  decrypt: decryptCredential,
  storage,
  responses: createResponseStorage(mongoose),
  getChannel: db.getAgentChannelMetadata,
  resolvePrincipal: authority.resolvePrincipal,
  createKey: db.createAgentApiKey,
  getKey: db.getAgentApiKeyById,
  deleteKey: db.deleteAgentApiKey,
  lifetimeMs: async () =>
    channelConfigSchema.parse(
      (await getAppConfig({ baseOnly: true })).endpoints?.agents?.channels ?? {},
    ).responseCredentialLifetimeMs,
});

module.exports = {
  storage,
  authority,
  responseCredentials,
  authorizeChannelResponseKeyRequest: responseCredentials.authorizeRequest,
  authorizeChannelResponseKeySource: responseCredentials.authorizeSource,
  authorizeTrigger: authority.authorizeTrigger,
  authorizeGeneration: authority.authorizeGeneration,
  authorizeResume: authority.authorizeResume,
};

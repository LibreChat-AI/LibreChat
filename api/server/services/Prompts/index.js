const {
  createPromptHandlers,
  createNativePromptService,
  createPromptAccessResolvers,
} = require('@librechat/api');
const { getEffectivePermissions, grantPermission } = require('~/server/services/PermissionService');
const db = require('~/models');

let promptService;

function getPromptService() {
  promptService ??= createNativePromptService({ db, grantPermission });
  return promptService;
}

function getPromptHandlers() {
  return createPromptHandlers({
    service: getPromptService(),
    getPromptGroupAccessContext: db.getPromptGroupAccessContext,
    getEffectivePermissions,
  });
}

function getPromptAccessResolvers() {
  return createPromptAccessResolvers(db);
}

module.exports = { getPromptService, getPromptHandlers, getPromptAccessResolvers };

const { createPromptService } = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config');
const { grantPermission } = require('~/server/services/PermissionService');
const db = require('~/models');

/** The one prompt service for this process. */
const promptService = createPromptService({ db, grantPermission, getAppConfig });

module.exports = { promptService };

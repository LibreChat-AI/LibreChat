const { createAssistantAuthorValidator } = require('@librechat/api');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { getAssistant } = require('~/models');

module.exports = createAssistantAuthorValidator({ getAssistant, hasCapability });

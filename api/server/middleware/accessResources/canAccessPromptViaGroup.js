const { ResourceType } = require('librechat-data-provider');
const { createPromptAccessResolvers } = require('@librechat/api');
const { canAccessResource } = require('./canAccessResource');
const db = require('~/models');

const { resolvePromptViaGroup } = createPromptAccessResolvers(db);

/**
 * Middleware factory that checks promptGroup permissions when accessing individual prompts.
 * This allows permission management at the promptGroup level while still supporting
 * individual prompt access patterns. On success, the loaded revision is available as
 * `req.resourceAccess.resourceInfo.prompt`.
 *
 * @param {Object} options - Configuration options
 * @param {number} options.requiredPermission - The permission bit required (1=view, 2=edit, 4=delete, 8=share)
 * @param {string} [options.resourceIdParam='promptId'] - The name of the route parameter containing the prompt ID
 * @returns {Function} Express middleware function
 */
const canAccessPromptViaGroup = (options) => {
  const { requiredPermission, resourceIdParam = 'promptId' } = options;

  if (!requiredPermission || typeof requiredPermission !== 'number') {
    throw new Error('canAccessPromptViaGroup: requiredPermission is required and must be a number');
  }

  return canAccessResource({
    resourceType: ResourceType.PROMPTGROUP,
    requiredPermission,
    resourceIdParam,
    idResolver: resolvePromptViaGroup,
  });
};

module.exports = {
  canAccessPromptViaGroup,
};

const { ResourceType } = require('librechat-data-provider');
const { createPromptAccessResolvers } = require('@librechat/api');
const { canAccessResource } = require('./canAccessResource');
const db = require('~/models');

const { resolvePromptGroup } = createPromptAccessResolvers(db);

/**
 * PromptGroup-specific middleware factory that creates middleware to check promptGroup access permissions.
 * On success, the loaded group is available as `req.resourceAccess.resourceInfo`.
 *
 * @param {Object} options - Configuration options
 * @param {number} options.requiredPermission - The permission bit required (1=view, 2=edit, 4=delete, 8=share)
 * @param {string} [options.resourceIdParam='groupId'] - The name of the route parameter containing the promptGroup ID
 * @returns {Function} Express middleware function
 */
const canAccessPromptGroupResource = (options) => {
  const { requiredPermission, resourceIdParam = 'groupId' } = options;

  if (!requiredPermission || typeof requiredPermission !== 'number') {
    throw new Error(
      'canAccessPromptGroupResource: requiredPermission is required and must be a number',
    );
  }

  return canAccessResource({
    resourceType: ResourceType.PROMPTGROUP,
    requiredPermission,
    resourceIdParam,
    idResolver: resolvePromptGroup,
  });
};

module.exports = {
  canAccessPromptGroupResource,
};

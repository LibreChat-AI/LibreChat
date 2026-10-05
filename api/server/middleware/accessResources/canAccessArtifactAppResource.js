const { ResourceType } = require('librechat-data-provider');
const { canAccessResource } = require('./canAccessResource');
const { resolveArtifactAppId } = require('~/models');

/**
 * Artifact-app-specific middleware factory that checks access permissions.
 * Wraps the generic `canAccessResource` with the ARTIFACT_APP resource type and
 * `resolveArtifactAppId` (custom `app_*` id → ObjectId) as the ID resolver.
 *
 * @param {Object} options
 * @param {number} options.requiredPermission - Permission bit required (1=view, 2=edit, 4=delete, 8=share)
 * @param {string} [options.resourceIdParam='id'] - Route parameter holding the artifact app id
 * @returns {Function} Express middleware
 */
const canAccessArtifactAppResource = (options) => {
  const { requiredPermission, resourceIdParam = 'id' } = options || {};

  if (!requiredPermission || typeof requiredPermission !== 'number') {
    throw new Error(
      'canAccessArtifactAppResource: requiredPermission is required and must be a number',
    );
  }

  return canAccessResource({
    resourceType: ResourceType.ARTIFACT_APP,
    requiredPermission,
    resourceIdParam,
    idResolver: (artifactAppId) => resolveArtifactAppId({ artifactAppId }),
  });
};

module.exports = {
  canAccessArtifactAppResource,
};

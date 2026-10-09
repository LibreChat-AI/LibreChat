const { ResourceType, PermissionBits } = require('librechat-data-provider');
const { canAccessResource } = require('./canAccessResource');
const { getSkillById } = require('~/models');
const { getDeploymentSkillById } = require('@librechat/api');

/**
 * Skill-specific middleware factory that checks skill access permissions.
 * Wraps the generic `canAccessResource` with the SKILL resource type and
 * `getSkillById` as the ID resolver.
 *
 * @param {Object} options
 * @param {number} options.requiredPermission - Permission bit required (1=view, 2=edit, 4=delete, 8=share)
 * @param {string} [options.resourceIdParam='id'] - Route parameter name holding the skill id
 * @returns {Function} Express middleware
 */
const canAccessSkillResource = (options) => {
  const { requiredPermission, resourceIdParam = 'id' } = options || {};

  if (!requiredPermission || typeof requiredPermission !== 'number') {
    throw new Error('canAccessSkillResource: requiredPermission is required and must be a number');
  }

  const aclMiddleware = canAccessResource({
    resourceType: ResourceType.SKILL,
    requiredPermission,
    resourceIdParam,
    idResolver: getSkillById,
  });

  return (req, res, next) => {
    const rawResourceId = req.params[resourceIdParam];
    const deploymentSkill = rawResourceId ? getDeploymentSkillById(rawResourceId) : null;
    if (!deploymentSkill) {
      return aclMiddleware(req, res, next);
    }
    if (requiredPermission !== PermissionBits.VIEW) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Deployment skills are read-only',
      });
    }
    req.resourceAccess = {
      resourceType: ResourceType.SKILL,
      resourceId: deploymentSkill._id,
      customResourceId: rawResourceId,
      permission: requiredPermission,
      userId: req.user?.id,
      resourceInfo: deploymentSkill,
    };
    return next();
  };
};

module.exports = {
  canAccessSkillResource,
};

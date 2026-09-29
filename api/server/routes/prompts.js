const express = require('express');
const { generateCheckAccess } = require('@librechat/api');
const { Permissions, PermissionBits, PermissionTypes } = require('librechat-data-provider');
const {
  canAccessPromptGroupResource,
  canAccessPromptViaGroup,
  promptUsageLimiter,
  requireJwtAuth,
  configMiddleware,
} = require('~/server/middleware');
const { getPromptHandlers } = require('~/server/services/Prompts');
const { getRoleByName } = require('~/models');

const router = express.Router();
const handlers = getPromptHandlers();

const checkPromptAccess = generateCheckAccess({
  permissionType: PermissionTypes.PROMPTS,
  permissions: [Permissions.USE],
  getRoleByName,
});
const checkPromptCreate = generateCheckAccess({
  permissionType: PermissionTypes.PROMPTS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});

router.use(requireJwtAuth);
router.use(checkPromptAccess);

router.get(
  '/groups/:groupId',
  canAccessPromptGroupResource({ requiredPermission: PermissionBits.VIEW }),
  configMiddleware,
  handlers.getPromptGroup,
);
router.get('/all', configMiddleware, handlers.listAllPromptGroups);
router.get('/groups', configMiddleware, handlers.listPromptGroups);

router.post('/', checkPromptCreate, configMiddleware, handlers.createPromptGroup);
router.post(
  '/groups/:groupId/prompts',
  checkPromptAccess,
  canAccessPromptGroupResource({ requiredPermission: PermissionBits.EDIT }),
  configMiddleware,
  handlers.savePrompt,
);
router.post(
  '/groups/:groupId/use',
  promptUsageLimiter,
  canAccessPromptGroupResource({ requiredPermission: PermissionBits.VIEW }),
  handlers.recordPromptUsage,
);

router.patch(
  '/groups/:groupId',
  checkPromptCreate,
  canAccessPromptGroupResource({ requiredPermission: PermissionBits.EDIT }),
  configMiddleware,
  handlers.updatePromptGroup,
);
router.patch(
  '/:promptId/tags/production',
  checkPromptCreate,
  canAccessPromptViaGroup({ requiredPermission: PermissionBits.EDIT, resourceIdParam: 'promptId' }),
  configMiddleware,
  handlers.makePromptProduction,
);

router.get(
  '/:promptId',
  canAccessPromptViaGroup({ requiredPermission: PermissionBits.VIEW, resourceIdParam: 'promptId' }),
  configMiddleware,
  handlers.getPrompt,
);
router.get('/', configMiddleware, handlers.getPrompts);

router.delete(
  '/:promptId',
  checkPromptCreate,
  canAccessPromptViaGroup({
    requiredPermission: PermissionBits.DELETE,
    resourceIdParam: 'promptId',
  }),
  handlers.deletePrompt,
);
router.delete(
  '/groups/:groupId',
  checkPromptCreate,
  canAccessPromptGroupResource({ requiredPermission: PermissionBits.DELETE }),
  handlers.deletePromptGroup,
);

module.exports = router;

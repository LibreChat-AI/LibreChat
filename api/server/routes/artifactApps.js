const express = require('express');
const {
  createArtifactAppHandlers,
  createSourceConversationExistsCheck,
  generateCheckAccess,
} = require('@librechat/api');
const { ResourceCapabilityMap } = require('@librechat/data-schemas');
const {
  Permissions,
  PermissionBits,
  PermissionTypes,
  ResourceType,
} = require('librechat-data-provider');
const {
  createArtifactAppWithVersion,
  syncArtifactAppWithVersion,
  restoreArtifactAppWithVersion,
  getArtifactAppByAppId,
  getArtifactAppBySource,
  getDeletedArtifactAppBySource,
  listArtifactApps,
  getArtifactAppsByIds,
  updateArtifactApp,
  deleteArtifactApp,
  prepareArtifactAppDeletion,
  finalizeArtifactAppDeletion,
  getArtifactVersion,
  listArtifactVersions,
  releaseArtifactVersion,
  activateArtifactVersion,
  withdrawArtifactVersion,
  recordAuditEntry,
  getRoleByName,
  getConvo,
} = require('~/models');
const { requireJwtAuth, canAccessArtifactAppResource } = require('~/server/middleware');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const {
  getResourcePermissionsMap,
  grantPermission,
  removeAllPermissions,
} = require('~/server/services/PermissionService');
const configMiddleware = require('~/server/middleware/config/app');

const router = express.Router();

router.use(requireJwtAuth);
router.use(configMiddleware);

const checkArtifactAccess = generateCheckAccess({
  permissionType: PermissionTypes.ARTIFACTS,
  permissions: [Permissions.USE],
  getRoleByName,
});
const checkArtifactCreate = generateCheckAccess({
  permissionType: PermissionTypes.ARTIFACTS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});

const handlers = createArtifactAppHandlers({
  createArtifactAppWithVersion,
  syncArtifactAppWithVersion,
  restoreArtifactAppWithVersion,
  getArtifactAppByAppId,
  getArtifactAppBySource,
  getDeletedArtifactAppBySource,
  listArtifactApps,
  getArtifactAppsByIds,
  updateArtifactApp,
  deleteArtifactApp,
  prepareArtifactAppDeletion,
  finalizeArtifactAppDeletion,
  getArtifactVersion,
  listArtifactVersions,
  releaseArtifactVersion,
  activateArtifactVersion,
  withdrawArtifactVersion,
  getResourcePermissionsMap,
  grantPermission,
  removeAllPermissions,
  hasResourceManagementCapability: (user) =>
    hasCapability(user, ResourceCapabilityMap[ResourceType.ARTIFACT_APP]),
  recordAuditEntry,
  sourceConversationExists: createSourceConversationExistsCheck(getConvo),
  getConfig: (req) => req.config?.artifactApps,
});

// Collection
router.get('/', checkArtifactAccess, handlers.list);
router.post('/', checkArtifactCreate, handlers.publish);
router.post('/sync', checkArtifactCreate, handlers.sync);
router.post('/restore', checkArtifactCreate, handlers.restore);
router.get('/source', checkArtifactAccess, handlers.getBySource);

// Single app
router.get(
  '/:id',
  checkArtifactAccess,
  canAccessArtifactAppResource({ requiredPermission: PermissionBits.VIEW }),
  handlers.get,
);
router.patch(
  '/:id',
  checkArtifactAccess,
  canAccessArtifactAppResource({ requiredPermission: PermissionBits.EDIT }),
  handlers.update,
);
router.delete('/:id', checkArtifactAccess, handlers.remove);

// Versions
router.get(
  '/:id/versions',
  checkArtifactAccess,
  canAccessArtifactAppResource({ requiredPermission: PermissionBits.VIEW }),
  handlers.listVersions,
);
router.get(
  '/:id/versions/:versionId',
  checkArtifactAccess,
  canAccessArtifactAppResource({ requiredPermission: PermissionBits.VIEW }),
  handlers.getVersion,
);
router.post(
  '/:id/versions/:versionId/release',
  checkArtifactAccess,
  canAccessArtifactAppResource({ requiredPermission: PermissionBits.EDIT }),
  handlers.releaseVersion,
);
router.post(
  '/:id/versions/:versionId/activate',
  checkArtifactAccess,
  canAccessArtifactAppResource({ requiredPermission: PermissionBits.EDIT }),
  handlers.activateVersion,
);
router.post(
  '/:id/versions/:versionId/withdraw',
  checkArtifactAccess,
  canAccessArtifactAppResource({ requiredPermission: PermissionBits.EDIT }),
  handlers.withdrawVersion,
);

module.exports = router;

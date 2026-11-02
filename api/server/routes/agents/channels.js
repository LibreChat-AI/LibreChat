const express = require('express');
const { PermissionBits } = require('librechat-data-provider');
const { canAccessAgentResource } = require('~/server/middleware');
const handlers = require('~/server/services/Channels');
const { checkRemoteAgentsFeature } = require('./middleware');

const router = express.Router({ mergeParams: true });
router.use(checkRemoteAgentsFeature);
router.use(
  canAccessAgentResource({
    requiredPermission: PermissionBits.SHARE,
    resourceIdParam: 'agentId',
  }),
);
router.get('/', handlers.list);
router.post('/', handlers.create);
router.get('/:channelId/manifest', handlers.manifest);
router.patch('/:channelId', handlers.update);
router.delete('/:channelId', handlers.remove);

module.exports = router;

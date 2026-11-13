const express = require('express');
const { PermissionBits } = require('librechat-data-provider');
const { canAccessAgentResource, requireSameOrigin } = require('~/server/middleware');
const handlers = require('~/server/services/Channels');
const workspaceBindings = require('~/server/services/SlackWorkspaceBindings');
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
router.post('/workspace-connections', requireSameOrigin, workspaceBindings.create);
router.get('/:channelId/workspace-routes', workspaceBindings.read);
router.post('/:channelId/workspace-routes', requireSameOrigin, workspaceBindings.assign);
router.delete('/:channelId/workspace-routes', requireSameOrigin, workspaceBindings.remove);
router.get('/:channelId/manifest', handlers.manifest);
router.patch('/:channelId', handlers.update);
router.delete('/:channelId', handlers.remove);

module.exports = router;

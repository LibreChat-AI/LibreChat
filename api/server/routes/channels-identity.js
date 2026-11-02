const express = require('express');
const { requireJwtAuth, requireSameOrigin } = require('~/server/middleware');
const { identityHandlers: handlers } = require('~/server/services/Channels');

const router = express.Router();
// Service handlers apply the channel service guard, which establishes the exact tenant/channel.
router.get('/service/:channelId/identity/:externalUserId', handlers.inspectActor);
router.post('/service/:channelId/identity/:externalUserId/ticket', handlers.issue);
router.post('/service/:channelId/identity/:externalUserId/confirm', handlers.confirm);
router.post('/links/preview', requireJwtAuth, requireSameOrigin, handlers.preview);
router.post('/links/accept', requireJwtAuth, requireSameOrigin, handlers.accept);
router.get('/links', requireJwtAuth, handlers.list);
router.delete('/links/:linkId', requireJwtAuth, requireSameOrigin, handlers.revoke);

module.exports = router;

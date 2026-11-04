const express = require('express');
const { setOAuthSession } = require('@librechat/api');
const { requireJwtAuth, requireSameOrigin } = require('~/server/middleware');
const { markOAuthNavigation } = require('~/server/middleware/oauthNavigation');
const { loginLimiter } = require('~/server/middleware/limiters');
const handlers = require('~/server/services/SlackWorkspaces');

const router = express.Router();
router.get('/workspaces/oauth/callback', markOAuthNavigation, loginLimiter, handlers.callback);
router.get('/workspaces', requireJwtAuth, handlers.list);
router.delete('/workspaces/attempts/:flowId', requireJwtAuth, requireSameOrigin, handlers.cancel);
router.post(
  '/workspaces/connect',
  requireJwtAuth,
  requireSameOrigin,
  setOAuthSession,
  handlers.connect,
);
router.delete('/workspaces/:workspaceId', requireJwtAuth, requireSameOrigin, handlers.disconnect);
module.exports = router;

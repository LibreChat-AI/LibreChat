const express = require('express');
const { setOAuthSession, preAuthTenantMiddleware } = require('@librechat/api');
const { requireJwtAuth, requireSameOrigin } = require('~/server/middleware');
const { markOAuthNavigation } = require('~/server/middleware/oauthNavigation');
const { loginLimiter } = require('~/server/middleware/limiters');
const handlers = require('~/server/services/SlackWorkspaces');

const router = express.Router();
router.get(
  '/workspaces/oauth/callback',
  preAuthTenantMiddleware,
  markOAuthNavigation,
  loginLimiter,
  handlers.callback,
);
router.get('/workspaces', requireJwtAuth, handlers.list);
router.get('/workspaces/apps', requireJwtAuth, handlers.apps);
router.put('/workspaces/apps', requireJwtAuth, requireSameOrigin, handlers.configureApp);
router.post(
  '/workspaces/apps/:appId/remove',
  requireJwtAuth,
  requireSameOrigin,
  handlers.removeApp,
);
router.get('/workspaces/:workspaceId/managers', requireJwtAuth, handlers.managers);
router.get('/workspaces/:workspaceId/managers/search', requireJwtAuth, handlers.searchManagers);
router.put(
  '/workspaces/:workspaceId/managers',
  requireJwtAuth,
  requireSameOrigin,
  handlers.updateManagers,
);
router.get('/workspaces/:workspaceId', requireJwtAuth, handlers.get);
router.delete('/workspaces/attempts/:flowId', requireJwtAuth, requireSameOrigin, handlers.cancel);
router.post(
  '/workspaces/connect',
  requireJwtAuth,
  requireSameOrigin,
  setOAuthSession,
  handlers.connect,
);
router.delete('/workspaces/:workspaceId', requireJwtAuth, requireSameOrigin, handlers.disconnect);
router.post('/workspaces/:workspaceId/remove', requireJwtAuth, requireSameOrigin, handlers.remove);
module.exports = router;

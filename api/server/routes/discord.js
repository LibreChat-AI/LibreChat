const express = require('express');
const { setOAuthSession, preAuthTenantMiddleware } = require('@librechat/api');
const { requireJwtAuth, requireSameOrigin } = require('~/server/middleware');
const { markOAuthNavigation } = require('~/server/middleware/oauthNavigation');
const { loginLimiter } = require('~/server/middleware/limiters');
const handlers = require('~/server/services/DiscordManagement');

const router = express.Router();
router.get(
  '/oauth/callback',
  preAuthTenantMiddleware,
  markOAuthNavigation,
  loginLimiter,
  handlers.callback,
);
router.get('/apps', requireJwtAuth, handlers.applications);
router.put('/apps', requireJwtAuth, requireSameOrigin, handlers.configure);
router.post('/apps/:applicationId/commands', requireJwtAuth, requireSameOrigin, handlers.register);
router.get('/guilds', requireJwtAuth, handlers.guilds);
router.post('/connect', requireJwtAuth, requireSameOrigin, setOAuthSession, handlers.connect);
router.delete('/attempts/:flowId', requireJwtAuth, requireSameOrigin, handlers.cancel);
router.delete('/guilds/:installationId', requireJwtAuth, requireSameOrigin, handlers.disconnect);
module.exports = router;

const express = require('express');
const { setOAuthSession, preAuthTenantMiddleware } = require('@librechat/api');
const { requireJwtAuth, requireSameOrigin } = require('~/server/middleware');
const { markOAuthNavigation } = require('~/server/middleware/oauthNavigation');
const { loginLimiter } = require('~/server/middleware/limiters');
const handlers = require('~/server/services/DiscordManagement');
const channels = require('~/server/services/DiscordChannels');

const router = express.Router();
router.get('/service/runtime/bootstrap', channels.discovery.bootstrap);
router.get('/service/runtime/applications', channels.discovery.applications);
router.get('/service/runtime/channels', channels.discovery.channels);
router.get('/service/security/:applicationId', channels.routes.security);
router.post('/service/resolve', channels.routes.resolve);
router.post('/service/messages', channels.messages.submit);
router.post('/service/gateway/acquire', channels.gateway.acquire);
router.post('/service/gateway/renew', channels.gateway.renew);
router.post('/service/gateway/release', channels.gateway.release);
router.post('/service/gateway/bootstrap', channels.gateway.bootstrap);
router.post('/service/gateway/load', channels.gateway.load);
router.post('/service/gateway/save', channels.gateway.save);
router.post('/service/inbox/submit', channels.inbox.submit);
router.post('/service/inbox/claim', channels.inbox.claim);
router.post('/service/inbox/finish', channels.inbox.finish);
router.post('/service/inbox/defer', channels.inbox.defer);
router.get('/agents/:agentId/binding', requireJwtAuth, channels.bindings.status);
router.put('/agents/:agentId/binding', requireJwtAuth, requireSameOrigin, channels.bindings.bind);
router.delete(
  '/agents/:agentId/binding',
  requireJwtAuth,
  requireSameOrigin,
  channels.bindings.remove,
);
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

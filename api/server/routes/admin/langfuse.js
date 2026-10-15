const express = require('express');
const {
  ioredisClient,
  createDistributedLock,
  createAdminLangfuseHandlers,
} = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const {
  hasConfigCapability,
  requireCapability,
} = require('~/server/middleware/roles/capabilities');
const { grantPermission } = require('~/server/services/PermissionService');
const { invalidateConfigCaches } = require('~/server/services/Config');
const configMiddleware = require('~/server/middleware/config/app');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireManagePrompts = requireCapability(SystemCapabilities.MANAGE_PROMPTS);

// Shared across every sync request this process handles, the same way the
// cache clients it wraps are shared; a Redis client makes the lock coordinate
// across every LibreChat node, and `ioredisClient` is null when Redis is not
// configured, so the factory falls back to the in-process lock already
// relied on for other single-node deployments.
const lock = createDistributedLock({ redisClient: ioredisClient });

async function requireLangfuseManage(req, res, next) {
  try {
    const id = req.user?.id ?? req.user?._id?.toString();
    if (!id) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    const user = {
      id,
      role: req.user.role ?? '',
      tenantId: req.user.tenantId,
      idOnTheSource: req.user.idOnTheSource ?? null,
    };
    if (await hasConfigCapability(user, 'langfuse')) {
      return next();
    }
    return res.status(403).json({ message: 'Forbidden' });
  } catch (_err) {
    return res.status(500).json({ message: 'Internal Server Error' });
  }
}

const handlers = createAdminLangfuseHandlers({
  findConfigByPrincipal: db.findConfigByPrincipal,
  patchConfigFields: db.patchConfigFields,
  toggleConfigActive: db.toggleConfigActive,
  getMessages: db.getMessages,
  findLangfusePromptGroup: db.findLangfusePromptGroup,
  createLangfusePromptGroup: db.createLangfusePromptGroup,
  deletePromptGroup: db.deletePromptGroup,
  lock,
  grantPermission,
  invalidateConfigCaches,
  recordAuditEntry: db.recordAuditEntry,
});

// `configMiddleware` runs last so unauthorized callers are rejected before the
// config resolves; credential verification reads the deployment's Langfuse
// headers off `req.config`, so without it proxied hosts reject every request.
router.use(requireJwtAuth, requireAdminAccess, requireLangfuseManage, configMiddleware);

router.get('/connection', handlers.getConnection);
router.get('/connection/session/:conversationId', handlers.getSessionLink);
router.put('/connection', handlers.updateConnection);
router.post('/connection/test', handlers.testConnection);
router.put('/prompt-sync', handlers.updatePromptSync);
router.get('/prompts', handlers.listPrompts);
router.post('/prompts/sync', requireManagePrompts, handlers.syncPrompts);
router.get('/prompts/:name', handlers.getPrompt);

module.exports = router;

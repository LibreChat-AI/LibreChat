const express = require('express');
const {
  createTraceHandlers,
  limiterCache,
  createTraceReadLimiter,
  createLangfuseTraceReader,
  resolveLangfuseReadDestinations,
} = require('@librechat/api');
const configMiddleware = require('~/server/middleware/config/app');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();

const handlers = createTraceHandlers({
  reader: createLangfuseTraceReader({
    getConversationTraceRefs: db.getConversationTraceRefs,
    hasSampledTraceMessage: db.hasSampledTraceMessage,
    resolveDestinations: resolveLangfuseReadDestinations,
    fetch: (url, init) => fetch(url, init),
  }),
  getConvoOwnership: db.getConvoOwnership,
});
const traceReadLimiter = createTraceReadLimiter({
  store: limiterCache('trace_viewer_user_limiter'),
});

router.use(requireJwtAuth, configMiddleware);
router.get('/:conversationId/availability', handlers.availability);
router.get('/:conversationId/records', traceReadLimiter, handlers.records);
router.get('/:conversationId/records/:recordId', traceReadLimiter, handlers.record);

module.exports = router;

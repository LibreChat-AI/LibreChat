const express = require('express');
const {
  GenerationJobManager,
  createCodeEnvironmentHttpHandlers,
  codeEnvironmentPairingLimiter,
  codeEnvironmentStatusIpLimiter,
  codeEnvironmentStatusLimiter,
} = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { getAppConfig, getCodeEnvironmentRegistry } = require('~/server/services/Config');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();
let handlers;
function getHandlers() {
  if (handlers == null) {
    handlers = createCodeEnvironmentHttpHandlers({
      getAppConfig,
      registry: getCodeEnvironmentRegistry(),
      principalIsActive: db.isAgentTriggerPrincipalActive,
      conversations: {
        get: db.getConvoCodeEnvironmentDecision,
        replaceDecision: db.replaceConvoCodeEnvironmentDecision,
      },
      generations: GenerationJobManager,
    });
  }
  return handlers;
}
const requireCodeEnvironmentManage = requireCapability(SystemCapabilities.MANAGE_CODE_ENVIRONMENTS);

router.use(requireJwtAuth);
router.get('/', (req, res, next) => getHandlers().list(req, res, next));
router.post('/pairings', codeEnvironmentPairingLimiter, (req, res, next) =>
  getHandlers().pair(req, res, next),
);
router.post('/', requireCodeEnvironmentManage, (req, res, next) =>
  getHandlers().register(req, res, next),
);
router.get(
  '/:environmentId/status',
  codeEnvironmentStatusIpLimiter,
  codeEnvironmentStatusLimiter,
  (req, res, next) => getHandlers().status(req, res, next),
);
router.patch('/:environmentId/settings', (req, res, next) =>
  getHandlers().updateSettings(req, res, next),
);
router.delete('/:environmentId', (req, res, next) => getHandlers().remove(req, res, next));
router.patch(
  '/conversations/:conversationId/decision',
  codeEnvironmentStatusIpLimiter,
  codeEnvironmentStatusLimiter,
  (req, res, next) => getHandlers().moveConversationDecision(req, res, next),
);

module.exports = router;

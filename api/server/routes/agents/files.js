const express = require('express');
const { sendRemoteAgentFile } = require('@librechat/api');
const { configMiddleware, requireTermsAcceptance } = require('~/server/middleware');
const { fileAccess } = require('~/server/middleware/accessResources/fileAccess');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const {
  preAuthTenantMiddleware,
  requireRemoteAgentAuth,
  checkRemoteAgentsFeature,
} = require('./middleware');

const router = express.Router();

router.use(preAuthTenantMiddleware);
router.use(requireRemoteAgentAuth);
router.use(requireTermsAcceptance);
router.use(configMiddleware);
router.use(checkRemoteAgentsFeature);

/**
 * Remote Agents use their API credential rather than a browser session, so generated files need
 * a content route under the same authentication boundary as the Responses endpoint.
 */
router.get('/:file_id/content', fileAccess, (req, res) =>
  sendRemoteAgentFile({
    req,
    res,
    file: req.fileAccess.file,
    getStrategyFunctions,
  }),
);

module.exports = router;

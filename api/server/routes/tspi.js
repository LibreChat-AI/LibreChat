const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { Permissions, PermissionTypes } = require('librechat-data-provider');
const {
  TspiReportError,
  openTspiPatient,
  tspiActionError,
  generateCheckAccess,
  createTspiReportPdf,
  createTspiBrainClient,
  decideTspiConfirmation,
} = require('@librechat/api');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();

const ERROR_STATUS = { invalid_id: 400, not_found: 404, forbidden: 403, unavailable: 502 };

const checkMCPUse = generateCheckAccess({
  permissionType: PermissionTypes.MCP_SERVERS,
  permissions: [Permissions.USE],
  getRoleByName: db.getRoleByName,
});

/** Same ownership rule as `validateConvoAccess`. */
const actionDeps = {
  ownsConversation: async (userId, conversationId) => {
    const convo = await db.searchConversation(conversationId, '-messages');
    return Boolean(convo) && convo.user === userId;
  },
};

router.get(
  '/reports/:reportId/pdf',
  requireJwtAuth,
  configMiddleware,
  checkMCPUse,
  async (req, res) => {
    try {
      const { filename, buffer } = await createTspiReportPdf(
        req.params.reportId,
        createTspiBrainClient(req.user),
      );
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(buffer);
    } catch (error) {
      if (error instanceof TspiReportError) {
        logger.warn(`[TSPI PDF] ${error.code} for report ${req.params.reportId}: ${error.message}`);
        return res.status(ERROR_STATUS[error.code] ?? 502).json({ error: error.code });
      }
      logger.error('[TSPI PDF] Failed to build report PDF', error);
      return res.status(502).json({ error: 'unavailable' });
    }
  },
);

router.post(
  '/confirmations/:confirmationId',
  requireJwtAuth,
  configMiddleware,
  checkMCPUse,
  async (req, res) => {
    try {
      const result = await decideTspiConfirmation(
        req.user,
        { ...req.body, confirmationId: req.params.confirmationId },
        actionDeps,
      );
      return res.status(200).json(result);
    } catch (error) {
      const { status, body } = tspiActionError(error);
      logger.warn(`[TSPI confirm] ${req.params.confirmationId}: ${status} ${body.error}`);
      return res.status(status).json(body);
    }
  },
);

router.post(
  '/chat-context/open',
  requireJwtAuth,
  configMiddleware,
  checkMCPUse,
  async (req, res) => {
    try {
      return res.status(200).json(await openTspiPatient(req.user, req.body, actionDeps));
    } catch (error) {
      const { status, body } = tspiActionError(error);
      logger.warn(`[TSPI open] ${status} ${body.error}`);
      return res.status(status).json(body);
    }
  },
);

module.exports = router;

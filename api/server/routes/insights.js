const express = require('express');
const {
  createInsightsAccessHandler,
  createInsightsAccessResolver,
  createInsightsHandler,
  isEnabled,
} = require('@librechat/api');
const { requireJwtAuth, strictConfigMiddleware } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();
const isLegacyInsightsEnabled = () => isEnabled(process.env.ENABLE_INSIGHTS);
const getInsightsAccess = createInsightsAccessResolver({
  getAgents: db.getAgents,
  getUserPrincipals: db.getUserPrincipals,
  hasCapabilityForPrincipals: db.hasCapabilityForPrincipals,
  findAccessibleResources: db.findAccessibleResources,
});

router.use(requireJwtAuth, strictConfigMiddleware);
router.get('/access', createInsightsAccessHandler({ getInsightsAccess, isLegacyInsightsEnabled }));
router.get(
  '/',
  createInsightsHandler({
    getInsightsAccess,
    isLegacyInsightsEnabled,
    getInsights: db.getInsights,
  }),
);

module.exports = router;

const express = require('express');
const {
  createInsightsAccessHandler,
  createInsightsAccessResolver,
  createInsightsConfigResolver,
  createInsightsHandler,
  isEnabled,
} = require('@librechat/api');
const { requireJwtAuth, strictConfigMiddleware } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();
const isInsightsEnabled = () => isEnabled(process.env.ENABLE_INSIGHTS);
const resolveInsightsConfig = createInsightsConfigResolver(isInsightsEnabled);
const getInsightsAccess = createInsightsAccessResolver({
  getAgents: db.getAgents,
  getUserPrincipals: db.getUserPrincipals,
  hasCapabilityForPrincipals: db.hasCapabilityForPrincipals,
  findAccessibleResources: db.findAccessibleResources,
});

router.use(requireJwtAuth, strictConfigMiddleware);
router.get('/access', createInsightsAccessHandler({ resolveInsightsConfig, getInsightsAccess }));
router.get(
  '/',
  createInsightsHandler({
    resolveInsightsConfig,
    getInsightsAccess,
    getInsights: db.getInsights,
  }),
);

module.exports = router;

const express = require('express');
const {
  createInsightsAccessHandler,
  createInsightsAccessResolver,
  createInsightsHandler,
  isEnabled,
} = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();
const isInsightsEnabled = () => isEnabled(process.env.ENABLE_INSIGHTS);
const getAccess = createInsightsAccessResolver({
  getAgents: db.getAgents,
  getUserPrincipals: db.getUserPrincipals,
  hasCapabilityForPrincipals: db.hasCapabilityForPrincipals,
  findAccessibleResources: db.findAccessibleResources,
});

router.use(requireJwtAuth);
router.get('/access', createInsightsAccessHandler({ isInsightsEnabled, getAccess }));
router.get(
  '/',
  createInsightsHandler({ isInsightsEnabled, getAccess, getInsights: db.getInsights }),
);

module.exports = router;

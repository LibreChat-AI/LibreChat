const express = require('express');
const {
  createInsightsAccessHandler,
  createInsightsAgentAccessResolver,
  createInsightsHandler,
  isEnabled,
} = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();
const isInsightsEnabled = () => isEnabled(process.env.ENABLE_INSIGHTS);
const getAccessibleAgents = createInsightsAgentAccessResolver({
  getAgents: db.getAgents,
  getUserPrincipals: db.getUserPrincipals,
  hasCapabilityForPrincipals: db.hasCapabilityForPrincipals,
  findAccessibleResources: db.findAccessibleResources,
});

router.use(requireJwtAuth);
router.get('/access', createInsightsAccessHandler({ isInsightsEnabled, getAccessibleAgents }));
router.get(
  '/',
  createInsightsHandler({ isInsightsEnabled, getAccessibleAgents, getInsights: db.getInsights }),
);

module.exports = router;

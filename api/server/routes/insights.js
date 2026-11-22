const express = require('express');
const {
  createInsightsAccessHandler,
  createInsightsAccessResolver,
  createInsightsHandler,
} = require('@librechat/api');
const { requireJwtAuth, strictConfigMiddleware } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();
const getInsightsAccess = createInsightsAccessResolver({
  getAgents: db.getAgents,
  getUserPrincipals: db.getUserPrincipals,
  hasCapabilityForPrincipals: db.hasCapabilityForPrincipals,
  findAccessibleResources: db.findAccessibleResources,
});

router.use(requireJwtAuth, strictConfigMiddleware);
router.get('/access', createInsightsAccessHandler({ getInsightsAccess }));
router.get('/', createInsightsHandler({ getInsightsAccess, getInsights: db.getInsights }));

module.exports = router;

const express = require('express');
const { createNearAIHandlers, nearAIService } = require('@librechat/api');
const { getUserKeyValues } = require('~/models');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const { strictConfigMiddleware } = require('~/server/middleware/config/app');

const router = express.Router();
router.get(
  '/attestation',
  requireJwtAuth,
  strictConfigMiddleware,
  createNearAIHandlers(nearAIService, getUserKeyValues),
);
module.exports = router;

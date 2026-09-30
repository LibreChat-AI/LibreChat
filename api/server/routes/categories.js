const express = require('express');
const { createGetPromptCategoriesHandler } = require('@librechat/api');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');
const { getPromptGroupAccessContext, getDistinctPromptGroupCategories } = require('~/models');

const router = express.Router();

router.get(
  '/',
  requireJwtAuth,
  configMiddleware,
  createGetPromptCategoriesHandler({
    getPromptGroupAccessContext,
    getDistinctPromptGroupCategories,
  }),
);

module.exports = router;

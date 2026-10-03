const express = require('express');
const { PermissionTypes, Permissions } = require('librechat-data-provider');
const { checkAccess, createGetPromptCategoriesHandler } = require('@librechat/api');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');
const {
  getRoleByName,
  getPromptGroupAccessContext,
  getDistinctPromptGroupCategories,
} = require('~/models');

const router = express.Router();

router.get(
  '/',
  requireJwtAuth,
  configMiddleware,
  createGetPromptCategoriesHandler({
    getPromptGroupAccessContext,
    getDistinctPromptGroupCategories,
    canUsePrompts: (req) =>
      checkAccess({
        req,
        user: req.user,
        permissionType: PermissionTypes.PROMPTS,
        permissions: [Permissions.USE],
        getRoleByName,
      }),
  }),
);

module.exports = router;

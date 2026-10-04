const express = require('express');
const { createSkillManagementHandlers, mapAgentManagementError } = require('@librechat/api');
const { createFileLimiters } = require('~/server/middleware/limiters/uploadLimiters');
const { maybeRunGitHubSkillSyncForRequest } = require('~/server/services/Skills/sync');
const { checkBan, configMiddleware } = require('~/server/middleware');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { checkPermission } = require('~/server/services/PermissionService');
const { getSkillsHandlers } = require('~/server/services/Skills/handlers');
const {
  getSkillDbMethods,
  getSkillManagementFileSaver,
} = require('~/server/services/Endpoints/agents/skillDeps');
const { getRoleByName } = require('~/models');
const { requireAgentManagementAuth } = require('./middleware');

const router = express.Router();
const { fileUploadIpLimiter, fileUploadUserLimiter } = createFileLimiters();
const handlers = createSkillManagementHandlers({
  beforeList: maybeRunGitHubSkillSyncForRequest,
  fileWriteLimiters: [fileUploadIpLimiter, fileUploadUserLimiter],
  handlers: getSkillsHandlers(),
  getSkillById: getSkillDbMethods().getSkillById,
  getRoleByName,
  checkPermission,
  hasCapability,
  saveFile: getSkillManagementFileSaver(),
});
router.use(requireAgentManagementAuth, checkBan, configMiddleware);
router.get('/', handlers.list);
router.get('/:id', handlers.get);
router.patch('/:id', handlers.update);
router.get('/:id/files', handlers.listFiles);
router.get('/:id/files/*relativePath', handlers.getFile);
router.put('/:id/files/*relativePath', handlers.updateFile);
router.use((_req, res) => {
  const { status, body } = mapAgentManagementError('not_found');
  body.error.message = 'Skill or file not found';
  return res.status(status).json(body);
});
module.exports = router;

const express = require('express');
const { logger } = require('@librechat/data-schemas');
const {
  createMessageFilterPii,
  getPreinspectedPrivateText,
  reportLocatorTraversalFailure,
  generateCheckAccess,
  skipAgentCheck,
  createChatResumeContext,
  GenerationJobManager,
  getSafeErrorMetadata,
  validateChatMessageIds,
} = require('@librechat/api');
const { PermissionTypes, Permissions, PermissionBits } = require('librechat-data-provider');
const {
  moderateText,
  // validateModel,
  validateConvoAccess,
  buildEndpointOption,
  canAccessAgentFromBody,
} = require('~/server/middleware');
const { initializeClient } = require('~/server/services/Endpoints/agents');
const guardSubagentThreadTurn = require('~/server/middleware/validate/subagentThreadTurn');
const AgentController = require('~/server/controllers/agents/request');
const ResumeController = require('~/server/controllers/agents/resume');
const addTitle = require('~/server/services/Endpoints/agents/title');
const { getFiles, getRoleByName } = require('~/models');

const router = express.Router();

const checkAgentAccess = generateCheckAccess({
  permissionType: PermissionTypes.AGENTS,
  permissions: [Permissions.USE],
  skipCheck: skipAgentCheck,
  getRoleByName,
});
const checkAgentResourceAccess = canAccessAgentFromBody({
  requiredPermission: PermissionBits.VIEW,
});

router.use(validateChatMessageIds);
router.use(
  createChatResumeContext({
    jobs: GenerationJobManager,
    onError: (error) =>
      logger.warn('[agents/chat] Failed to restore resume context', getSafeErrorMetadata(error)),
  }),
);
router.use(
  createMessageFilterPii({
    onTraversalFailure: reportLocatorTraversalFailure,
    getConfig: (req) => req.config?.messageFilter?.pii,
    getFilters: (req) => req.config?.filters,
    getPreinspectedText: getPreinspectedPrivateText,
    getFiles,
  }),
);
router.use(moderateText);
router.use(checkAgentAccess);
router.use(checkAgentResourceAccess);
router.use(validateConvoAccess);
router.use(guardSubagentThreadTurn);
router.use(buildEndpointOption);

const controller = async (req, res, next) => {
  await AgentController(req, res, next, initializeClient, addTitle);
};

const resumeController = async (req, res, next) => {
  await ResumeController(req, res, next, initializeClient, addTitle);
};

/**
 * @route POST /resume
 * @desc Resume a generation paused for human-in-the-loop review (tool approval or
 *       ask-user answer). Shares this router's middleware so the agent/endpoint are
 *       reconstructed from the request exactly like a normal turn. Declared before
 *       `/:endpoint` so it is not captured as an ephemeral endpoint name.
 * @access Private
 * @returns {void}
 */
router.post('/resume', resumeController);

/**
 * @route POST / (regular endpoint)
 * @desc Chat with an assistant
 * @access Public
 * @param {express.Request} req - The request object, containing the request data.
 * @param {express.Response} res - The response object, used to send back a response.
 * @returns {void}
 */
router.post('/', controller);

/**
 * @route POST /:endpoint (ephemeral agents)
 * @desc Chat with an assistant
 * @access Public
 * @param {express.Request} req - The request object, containing the request data.
 * @param {express.Response} res - The response object, used to send back a response.
 * @returns {void}
 */
router.post('/:endpoint', controller);

module.exports = router;

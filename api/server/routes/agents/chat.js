const express = require('express');
const { logger } = require('@librechat/data-schemas');
const {
  createMessageFilterPii,
  reportLocatorTraversalFailure,
  generateCheckAccess,
  skipAgentCheck,
  applyResumeContext,
  applyResumeModelParameters,
  GenerationJobManager,
  getSafeErrorMetadata,
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

/**
 * Replay the paused turn's graph-determining config onto a resume request BEFORE the
 * rest of the chain (PII filter, agent-access, buildEndpointOption) reads it. The client
 * can't reliably re-send the ephemeral-agent config after a reload/cross-session, so the
 * server restores it from the pending action — the resume then rebuilds the SAME
 * agent/graph the run paused on (and a crafted resume can't swap the tool set). No-op for
 * every non-resume route.
 */
const restoreResumeContext = async (req, res, next) => {
  if (req.path !== '/resume') {
    return next();
  }
  try {
    const streamId = req.body?.conversationId;
    if (streamId) {
      const job = await GenerationJobManager.getJob(streamId);
      const resumeContext = job?.metadata?.pendingAction?.resumeContext;
      applyResumeContext(req.body, resumeContext);
      // Replay the paused turn's resolved model parameters. Ephemeral agents derive these
      // (temperature, max tokens, custom endpoint params) from the request body, which the
      // resume payload omits — without this the continuation runs with defaults. They're
      // scattered top-level fields (folded into model_parameters by buildOptions' rest
      // spread), not part of the RESUME_CONTEXT_KEYS allowlist, so merge them back here.
      // Generation params are authoritative, but routing, graph identity, and resume-action
      // fields remain owned by the restored context/request envelope.
      applyResumeModelParameters(req.body, resumeContext?.model_parameters);
    }
  } catch (err) {
    logger.warn('[agents/chat] Failed to restore resume context', getSafeErrorMetadata(err));
  }
  next();
};

router.use(restoreResumeContext);
router.use(
  createMessageFilterPii({
    onTraversalFailure: reportLocatorTraversalFailure,
    getConfig: (req) => req.config?.messageFilter?.pii,
    getFilters: (req) => req.config?.filters,
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

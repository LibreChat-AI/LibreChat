const express = require('express');
const {
  reportLocatorTraversalFailure,
  createResetToolApprovalController,
  createContentFilter,
  extractToolArgumentContent,
} = require('@librechat/api');
const { callTool, verifyToolAuth, getToolCalls } = require('~/server/controllers/tools');
const { ResourceType, PermissionBits } = require('librechat-data-provider');
const { checkPermission } = require('~/server/services/PermissionService');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { resolveAllMcpConfigs } = require('~/server/services/MCP');
const { getMCPServerTools } = require('~/server/services/Config');
const { getAvailableTools } = require('~/server/controllers/PluginController');
const { toolCallLimiter } = require('~/server/middleware');

const approvalStorage = require('~/models');
const router = express.Router();
router.post(
  '/approvals/reset',
  toolCallLimiter,
  createResetToolApprovalController({
    storage: approvalStorage,
    hasCapability,
    getMCPServerConfigs: resolveAllMcpConfigs,
    getMCPServerTools,
    getAgent: approvalStorage.getAgent,
    canAccessAgent: (agent, user) =>
      checkPermission({
        userId: user.id,
        role: user.role,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        requiredPermission: PermissionBits.VIEW,
      }),
  }),
);
const filterToolArguments = createContentFilter({
  onTraversalFailure: reportLocatorTraversalFailure,
  getFilters: (req) => req.config?.filters,
  extract: (req) => {
    const {
      partIndex: _partIndex,
      blockIndex: _blockIndex,
      messageId: _messageId,
      conversationId: _conversationId,
      ...args
    } = req.body ?? {};
    return extractToolArgumentContent({ name: req.params.toolId, arguments: args });
  },
});

/**
 * Get a list of available tools for agents.
 * @route GET /agents/tools
 * @returns {TPlugin[]} 200 - application/json
 */
router.get('/', getAvailableTools);

/**
 * Get a list of tool calls.
 * @route GET /agents/tools/calls
 * @returns {ToolCallData[]} 200 - application/json
 */
router.get('/calls', getToolCalls);

/**
 * Verify authentication for a specific tool
 * @route GET /agents/tools/:toolId/auth
 * @param {string} toolId - The ID of the tool to verify
 * @returns {{ authenticated?: boolean; message?: string }}
 */
router.get('/:toolId/auth', verifyToolAuth);

/**
 * Execute code for a specific tool
 * @route POST /agents/tools/:toolId/call
 * @param {string} toolId - The ID of the tool to execute
 * @param {object} req.body - Request body
 * @returns {object} Result of code execution
 */
router.post('/:toolId/call', toolCallLimiter, filterToolArguments, callTool);

module.exports = router;

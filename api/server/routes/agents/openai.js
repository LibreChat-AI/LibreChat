/**
 * OpenAI-compatible API routes for LibreChat agents.
 *
 * Provides a /v1/chat/completions compatible interface for
 * interacting with LibreChat agents remotely via API.
 *
 * Usage:
 *   POST /v1/chat/completions - Chat with an agent
 *   POST /v1/events - Durably deliver a source-neutral event
 *   GET /v1/events/:id - Read an event delivery status and result
 *   GET /v1/models - List available agents
 *   GET /v1/models/:model - Get agent details
 *
 * Request format:
 *   {
 *     "model": "agent_id_here",
 *     "messages": [{"role": "user", "content": "Hello!"}],
 *     "stream": true
 *   }
 */
const express = require('express');
const {
  reportLocatorTraversalFailure,
  createAgentEventBindingHandlers,
  createAgentTriggerIngressHandlers,
  createMessageFilterPii,
} = require('@librechat/api');
const {
  OpenAIChatCompletionController,
  ListModelsController,
  GetModelController,
} = require('~/server/controllers/agents/openai');
const { agentEventUserLimiter, configMiddleware } = require('~/server/middleware');
const {
  enqueueAgentTrigger,
  getAgentTriggerDeliveryStatus,
} = require('~/server/services/Agents/triggers');
const {
  checkAgentPermission,
  checkAgentTriggerPermission,
  preAuthTenantMiddleware,
  requireRemoteAgentAuth,
  checkRemoteAgentsFeature,
} = require('./middleware');
const db = require('~/models');

const router = express.Router();
const eventHandlers = createAgentTriggerIngressHandlers({
  enqueue: enqueueAgentTrigger,
  getDeliveryStatus: getAgentTriggerDeliveryStatus,
});
const eventBindingHandlers = createAgentEventBindingHandlers({
  getAgent: db.getAgent,
  getConvo: db.getConvo,
  getBinding: db.getAgentEventBinding,
  getMessage: db.getMessage,
  deleteConvos: db.deleteConvos,
  reserveThread: db.reserveSubagentThread,
});

router.use(preAuthTenantMiddleware);
router.use(requireRemoteAgentAuth);
router.use(configMiddleware);
router.use(checkRemoteAgentsFeature);

/**
 * @route POST /v1/events/bindings
 * @desc Bind one authenticated source key to a durable child actor thread
 * @access Private (API key auth required)
 */
router.post(
  '/events/bindings',
  agentEventUserLimiter,
  checkAgentTriggerPermission,
  eventBindingHandlers.register,
);

/**
 * @route POST /v1/events
 * @desc Durably deliver a source-neutral event to an agent
 * @access Private (API key auth required)
 */
router.post(
  '/events',
  agentEventUserLimiter,
  createMessageFilterPii({
    onTraversalFailure: reportLocatorTraversalFailure,
    getConfig: (req) => req.config?.messageFilter?.pii,
  }),
  eventBindingHandlers.resolve,
  checkAgentTriggerPermission,
  eventHandlers.enqueueEvent,
);

/**
 * @route GET /v1/events/:id
 * @desc Read the authenticated owner's delivery status and result
 * @access Private (API key auth required)
 */
router.get('/events/:id', eventHandlers.getEvent);

/**
 * @route POST /v1/chat/completions
 * @desc OpenAI-compatible chat completions with agents
 * @access Private (API key auth required)
 *
 * Request body:
 * {
 *   "model": "agent_id",        // Required: The agent ID to use
 *   "messages": [...],          // Required: Array of chat messages
 *   "stream": true,             // Optional: Whether to stream (default: false)
 *   "conversation_id": "...",   // Optional: Conversation ID for context
 *   "parent_message_id": "..."  // Optional: Parent message for threading
 * }
 *
 * Response (streaming):
 * - SSE stream with OpenAI chat.completion.chunk format
 * - Includes delta.reasoning for thinking/reasoning content
 *
 * Response (non-streaming):
 * - Standard OpenAI chat.completion format
 */
router.post('/chat/completions', checkAgentPermission, OpenAIChatCompletionController);

/**
 * @route GET /v1/models
 * @desc List available agents as models
 * @access Private (API key auth required)
 *
 * Response:
 * {
 *   "object": "list",
 *   "data": [
 *     {
 *       "id": "agent_id",
 *       "object": "model",
 *       "name": "Agent Name",
 *       "provider": "openai",
 *       ...
 *     }
 *   ]
 * }
 */
router.get('/models', ListModelsController);

/**
 * @route GET /v1/models/:model
 * @desc Get details for a specific agent/model
 * @access Private (API key auth required)
 */
router.get('/models/:model', GetModelController);

module.exports = router;

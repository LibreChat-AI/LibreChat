/**
 * OpenAI-compatible API for LibreChat agents.
 *
 * This module provides an OpenAI v1/chat/completions compatible interface
 * for interacting with LibreChat agents remotely via API.
 *
 * @example
 * ```typescript
 * import { createAgentChatCompletion, listAgentModels } from '@librechat/api';
 *
 * // POST /v1/chat/completions
 * app.post('/v1/chat/completions', async (req, res) => {
 *   await createAgentChatCompletion(req, res, dependencies);
 * });
 *
 * // GET /v1/models
 * app.get('/v1/models', async (req, res) => {
 *   await listAgentModels(req, res, { getAgents });
 * });
 * ```
 *
 * Request format:
 * ```json
 * {
 *   "model": "agent_id_here",
 *   "messages": [
 *     {"role": "user", "content": "Hello!"}
 *   ],
 *   "stream": true
 * }
 * ```
 *
 * The "model" parameter should be the agent ID you want to invoke.
 * Use the /v1/models endpoint to list available agents.
 */

export * from './types';
export * from './handlers';
export {
  createAgentChatCompletion,
  listAgentModels,
  convertMessages,
  mergeLeadingSystemMessages,
  validateRequest,
  isChatCompletionValidationFailure,
  createErrorResponse,
  sendErrorResponse,
  buildNonStreamingResponse,
  type ChatCompletionDependencies,
  type ChatCompletionValidationResult,
  type ChatCompletionValidationSuccess,
  type ChatCompletionValidationFailure,
} from './service';

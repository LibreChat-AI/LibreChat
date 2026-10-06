import type { LocatorTraversalReporter } from '../../protection/diagnostics';
/**
 * OpenAI-compatible chat completions service for agents.
 *
 * This service provides an OpenAI v1/chat/completions compatible API for
 * interacting with LibreChat agents. The agent_id is passed as the "model"
 * parameter per OpenAI spec.
 *
 * Usage:
 * ```typescript
 * import { createAgentChatCompletion } from '@librechat/api';
 *
 * // In your Express route handler:
 * app.post('/v1/chat/completions', async (req, res) => {
 *   await createAgentChatCompletion(req, res, {
 *     getAgent: db.getAgent,
 *     // ... other dependencies
 *   });
 * });
 * ```
 */
import { nanoid } from 'nanoid';
import { AgentCapabilities, EModelEndpoint } from 'librechat-data-provider';
import type {
  FiltersConfig,
  MessageFilterConfig,
  MessageFilterPiiConfig,
  StatefulCodeEnvironment,
  TAgentsEndpoint,
} from 'librechat-data-provider';
import type { Response as ServerResponse, Request } from 'express';
import type {
  ChatCompletionResponse,
  OpenAIResponseContext,
  ChatCompletionRequest,
  OpenAIErrorResponse,
  CompletionUsage,
  ChatMessage,
  ToolCall,
} from './types';
import type {
  ExternalChatMessage,
  ExternalMessagePart,
  ContentTraversalLimitError,
  TextContentFragment,
  FileContentInput,
} from '~/protection';
import type { InitializeAgentParams as CoreInitializeAgentParams } from '../initialize';
import type { OpenAIStreamWriterConfig, EventHandler } from './handlers';
import type { LangfuseTraceContext } from '~/langfuse/identity';
import type { MCPRuntimeRequestBody } from '~/mcp/request';
import type { ToolExecuteOptions } from '../handlers';
import {
  extractMessageContent,
  extractModelParameterContent,
  getBlockedOpaqueFileField,
  getContentTraversalFragments,
  inspectContent,
  isContentTraversalProtected,
  isContentTraversalLimitError,
} from '~/protection';
import {
  createOpenAIContentAggregator,
  createOpenAIStreamTracker,
  createOpenAIHandlers,
  completeOpenAIToolCalls,
  sendFinalChunk,
  createChunk,
  writeSSE,
} from './handlers';
import {
  assertModelBoundContent,
  hasModelBoundContentProtection,
} from '~/middleware/modelBoundContent';
import { contentFilterBlockResponse, isContentFilterError } from '~/middleware/contentFilter';
import { contentFilterUninspectableResponse } from '~/protection/files';
import { resolveToolRoleGrants } from '../../tools/rolePermissions';
import { createMCPRuntimeRequestBody } from '~/mcp/request';
import { getUserFacingProviderError } from '../errors';
import { collectReachableAgents } from '../traversal';
import { resolveRecursionLimit } from '../config';
import { getDynamicToolContexts } from '../hitl';
import { createSafeUser } from '~/utils';

/**
 * Dependencies for the chat completion service
 */
export interface ChatCompletionDependencies {
  readonly onTraversalFailure?: LocatorTraversalReporter;
  /** Get agent by ID */
  getAgent: (params: { id: string }) => Promise<Agent | null>;
  /** Initialize agent for use */
  initializeAgent: (params: InitializeAgentParams) => Promise<InitializedAgent>;
  /** Load agent tools */
  loadAgentTools?: LoadToolsFn;
  /** Get models config */
  getModelsConfig?: (req: Request) => Promise<unknown>;
  /** Validate agent model */
  validateAgentModel?: (
    params: unknown,
  ) => Promise<{ isValid: boolean; error?: { message: string } }>;
  /** Log violation */
  logViolation?: (
    req: Request,
    res: ServerResponse,
    type: string,
    info: unknown,
    score: number,
  ) => Promise<void>;
  /** Create agent run */
  createRun?: CreateRunFn;
  /**
   * App config. Optional for basic chat, but required for source-aware content
   * protection, tenant-scoped Langfuse fanout, and agents with `execute_code`
   * in their tools. Filter policy and tenant Langfuse keys are forwarded to
   * `createRun`, and the helper derives `codeEnvAvailable` from
   * `appConfig?.endpoints?.agents?.capabilities` and forwards it into
   * `deps.initializeAgent`. When `appConfig` is omitted, the resolved
   * `codeEnvAvailable` is `undefined`, so `initializeAgent` skips the
   * `execute_code` → `bash_tool` + `read_file` expansion entirely and
   * code-requesting agents silently lose sandbox tools. Pass `appConfig`
   * (even a minimal shape with just `endpoints.agents.capabilities`) to
   * keep tenant tracing and code execution working.
   */
  appConfig?: AppConfig;
  /**
   * Supply to have `codeEnvAvailable` and `fileSearchAvailable` respect the
   * caller's `RUN_CODE` / `FILE_SEARCH` grants as well as the deployment
   * capabilities. Optional so existing embedders keep their current behavior;
   * without it this route is gated by capability alone.
   */
  getRoleByName?: Parameters<typeof resolveToolRoleGrants>[0]['getRoleByName'];
  /** Tool execute options for event-driven tool execution */
  toolExecuteOptions?: ToolExecuteOptions;
  /**
   * Resolves an agent's `instructionsPrompt` link. Unlike `getRoleByName`,
   * this has no default resolution path — the embedder must build it (a
   * prompt service, cache, and logger) and supply it here for a linked agent
   * to receive resolved instructions instead of falling back to empty.
   */
  resolveLinkedInstructions?: CoreInitializeAgentParams['resolveLinkedInstructions'];
  /** Forwarded to `initializeAgent`; defaults to `true` when omitted. */
  recordLinkedPromptUsage?: CoreInitializeAgentParams['recordLinkedPromptUsage'];
}

/**
 * Agent type from librechat-data-provider
 */
interface Agent {
  id: string;
  name?: string;
  model?: string;
  provider: string;
  tools?: string[];
  instructions?: string;
  model_parameters?: Record<string, unknown>;
  tool_resources?: Record<string, unknown>;
  tool_options?: Record<string, unknown>;
  [key: string]: unknown;
}

interface InitializedFile extends FileContentInput {
  file_id?: string;
}

/**
 * Initialized agent type - note: after initialization, tools become structured tool objects
 */
interface InitializedAgent {
  id: string;
  name?: string;
  model?: string;
  provider: string;
  /** After initialization, tools are structured tool objects, not strings */
  tools: unknown[];
  instructions?: string;
  model_parameters?: Record<string, unknown>;
  tool_resources?: Record<string, unknown>;
  tool_options?: Record<string, unknown>;
  attachments: InitializedFile[];
  requestAttachments?: InitializedFile[];
  agentContextAttachments?: InitializedFile[];
  toolContextMap: Record<string, unknown>;
  dynamicToolContextMap?: Record<string, unknown>;
  maxContextTokens: number;
  userMCPAuthMap?: Record<string, Record<string, string>>;
  subagentAgentConfigs?: InitializedAgent[];
  /** Names of tools with the host-injected `intent` label param (see `agents/intent.ts`). */
  intentToolNames?: string[];
  recursion_limit?: number;
  [key: string]: unknown;
}

/**
 * Initialize agent params
 */
interface InitializeAgentParams {
  req: Request;
  res: ServerResponse;
  /** Cancellation signal owned by this chat-completion request. */
  signal?: CoreInitializeAgentParams['signal'];
  agent: Agent;
  conversationId?: string | null;
  parentMessageId?: string | null;
  requestBody?: MCPRuntimeRequestBody;
  requestFiles?: unknown[];
  loadTools?: NonNullable<CoreInitializeAgentParams['loadTools']>;
  endpointOption?: Record<string, unknown>;
  allowedProviders: Set<string>;
  isInitialAgent?: boolean;
  /**
   * Whether the `execute_code` capability is enabled for the run.
   * `initializeAgent` uses this to expand `agent.tools: ['execute_code']`
   * into the `bash_tool` + `read_file` pair — if the caller's injected
   * `initializeAgent` implementation consults this flag, agents configured
   * for code execution will keep working post-Phase-8. Absent / `undefined`
   * skips the expansion (same semantics as the in-repo controllers).
   */
  codeEnvAvailable?: boolean;
  /**
   * Whether `file_search` is available to this caller — the capability AND, when
   * the embedder wires `getRoleByName`, the `FILE_SEARCH` grant. Read only when
   * re-hydrating a conversation's prior-turn files; absent / `undefined` leaves
   * that priming unconditional.
   */
  fileSearchAvailable?: boolean;
  /**
   * Resolves the `WEB_SEARCH` role grant. `initializeAgent` calls it only when an
   * agent's built provider config turns native web search on, and strips that
   * search when it resolves `false`.
   */
  resolveWebSearchGrant?: () => Promise<boolean>;
  /**
   * Resolves this agent's `instructionsPrompt` link (a linked native prompt
   * group). `initializeAgent` calls it only when the agent carries a
   * resolvable link; absent, a linked agent falls back to empty instructions
   * with a warning, since there is no default resolution path.
   */
  resolveLinkedInstructions?: CoreInitializeAgentParams['resolveLinkedInstructions'];
  /** Forwarded to `initializeAgent`; defaults to `true` when omitted. */
  recordLinkedPromptUsage?: CoreInitializeAgentParams['recordLinkedPromptUsage'];
  /**
   * Whether the admin-level `stateful_code_sessions` capability is enabled.
   * Threaded to `initializeAgent` alongside `codeEnvAvailable` so this
   * OpenAI-compatible route resolves stateful sessions identically to the
   * in-repo controllers; absent / `undefined` disables the feature.
   */
  statefulSessionsAvailable?: boolean;
  /** Deployment allowlist carried explicitly because this route's Request has no req.config. */
  allowedStatefulCodeEnvironments?: readonly StatefulCodeEnvironment[];
  /**
   * Whether the admin-level `run_in_background` capability is enabled.
   * Gates `applyBackgroundToolCalls` in `initializeAgent` (the injected
   * `run_in_background` param + the `check_background_task` poll tool);
   * absent / `undefined` disables background tool calls on this route.
   */
  backgroundToolsAvailable?: boolean;
  /**
   * Whether the admin-level `tool_intents` capability is enabled. Gates
   * `applyIntentLabels` in `initializeAgent` (the injected `intent` label
   * param); absent / `undefined` disables intent labels on this route.
   *
   * Boundary: injection and the capability-off sanitize operate on the
   * `toolDefinitions`/`toolRegistry` surfaces. A custom `LoadToolsFn` that
   * returns only structured tool INSTANCES bypasses both — such loaders
   * must provide definition/registry surfaces to participate in intent
   * labels (matching how the in-repo tool loader behaves).
   */
  toolIntentsAvailable?: boolean;
}

/**
 * Tool loading function type
 */
type LoadToolsFn = (params: {
  req: Request;
  res: ServerResponse;
  provider: string;
  agentId: string;
  tools: string[];
  model: string | null;
  tool_options: unknown;
  tool_resources: unknown;
  requestBody?: MCPRuntimeRequestBody;
}) => Promise<{
  tools: unknown[];
  toolContextMap: Record<string, unknown>;
  userMCPAuthMap?: Record<string, Record<string, string>>;
} | null>;

/**
 * Create run function type
 */
type CreateRunAppConfig = Pick<AppConfig, 'endpoints' | 'filters' | 'langfuse' | 'messageFilter'>;

type CreateRunFn = (params: {
  agents: unknown[];
  messages: unknown[];
  runId: string;
  signal: AbortSignal;
  customHandlers: Record<string, EventHandler>;
  requestBody: Record<string, unknown>;
  user: Record<string, unknown>;
  traceContext?: LangfuseTraceContext;
  tenantId?: string;
  appConfig?: CreateRunAppConfig;
  tokenCounter?: (message: unknown) => number;
}) => Promise<{
  Graph?: unknown;
  processStream: (
    input: { messages: unknown[] },
    config: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<void>;
} | null>;

/**
 * App config type
 */
interface AppConfig {
  endpoints?: Record<string, unknown>;
  filters?: FiltersConfig;
  langfuse?: Record<string, unknown>;
  messageFilter?: MessageFilterConfig;
  [key: string]: unknown;
}

function selectCreateRunAppConfig(
  appConfig: AppConfig | undefined,
): CreateRunAppConfig | undefined {
  if (appConfig == null) {
    return undefined;
  }
  return {
    ...(appConfig.endpoints !== undefined && { endpoints: appConfig.endpoints }),
    ...(appConfig.filters !== undefined && { filters: appConfig.filters }),
    ...(appConfig.langfuse !== undefined && { langfuse: appConfig.langfuse }),
    ...(appConfig.messageFilter !== undefined && { messageFilter: appConfig.messageFilter }),
  };
}

function inspectSubmittedRequest(
  res: ServerResponse,
  request: ChatCompletionRequest,
  messages: readonly ExternalChatMessage[],
  filters: FiltersConfig | undefined,
  legacyPii: MessageFilterPiiConfig | undefined,
): boolean {
  if (filters == null && legacyPii == null) {
    return false;
  }

  const uninspectableField = getBlockedOpaqueFileField(filters, messages);
  if (uninspectableField != null) {
    const response = contentFilterUninspectableResponse(uninspectableField);
    sendErrorResponse(res, 400, response.message, 'invalid_request_error', response.error);
    return true;
  }

  const messageFragments: TextContentFragment[] = [];
  const traversalErrors: ContentTraversalLimitError[] = [];
  try {
    for (const fragment of extractMessageContent(messages)) {
      messageFragments.push(fragment);
    }
  } catch (error) {
    if (!isContentTraversalLimitError(error)) {
      throw error;
    }
    messageFragments.push(...getContentTraversalFragments(error));
    traversalErrors.push(error);
  }
  try {
    messageFragments.push(...extractModelParameterContent(request));
  } catch (error) {
    if (!isContentTraversalLimitError(error)) {
      throw error;
    }
    messageFragments.push(...getContentTraversalFragments(error));
    traversalErrors.push(error);
  }

  const finding = inspectContent(messageFragments, {
    filters,
    legacyPii,
  });
  if (finding != null) {
    const isLegacyFilter = finding.detectorId === 'legacy-pattern';
    const response = contentFilterBlockResponse(finding);
    sendErrorResponse(
      res,
      400,
      isLegacyFilter
        ? `Message contains a ${finding.label}. Remove it and try again.`
        : response.message,
      'invalid_request_error',
      isLegacyFilter ? 'message_filter_pii_block' : response.error,
    );
    return true;
  }

  const traversalError = traversalErrors.find((error) =>
    isContentTraversalProtected({
      error,
      filters,
      legacyPii,
      roles: messages.map((message) => message.role),
    }),
  );
  if (traversalError != null) {
    sendErrorResponse(
      res,
      traversalError.statusCode,
      traversalError.body.message,
      'invalid_request_error',
      traversalError.body.error,
    );
    return true;
  }
  return false;
}

/**
 * Convert OpenAI messages to LibreChat format
 */
export function convertMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((msg) => {
    let content: string | unknown[];
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (msg.content) {
      content = msg.content.map((part) => {
        if (part.type === 'text') {
          return { type: 'text', text: part.text };
        }
        if (part.type === 'image_url') {
          return { type: 'image_url', image_url: part.image_url };
        }
        return part;
      });
    } else {
      content = '';
    }

    return {
      role: msg.role,
      content,
      ...(msg.name && { name: msg.name }),
      ...(msg.tool_calls && { tool_calls: msg.tool_calls }),
      ...(msg.tool_call_id && { tool_call_id: msg.tool_call_id }),
    };
  });
}

/**
 * Create an error response in OpenAI format
 */
export function createErrorResponse(
  message: string,
  type = 'invalid_request_error',
  code: string | null = null,
): OpenAIErrorResponse {
  return {
    error: {
      message,
      type,
      param: null,
      code,
    },
  };
}

/**
 * Send an error response
 */
export function sendErrorResponse(
  res: ServerResponse,
  statusCode: number,
  message: string,
  type = 'invalid_request_error',
  code: string | null = null,
): void {
  res.status(statusCode).json(createErrorResponse(message, type, code));
}

/**
 * Validation result types for chat completion requests
 */
export type ChatCompletionValidationSuccess = { valid: true; request: ChatCompletionRequest };
export type ChatCompletionValidationFailure = { valid: false; error: string };
export type ChatCompletionValidationResult =
  | ChatCompletionValidationSuccess
  | ChatCompletionValidationFailure;

/**
 * Type guard for validation failure
 */
export function isChatCompletionValidationFailure(
  result: ChatCompletionValidationResult,
): result is ChatCompletionValidationFailure {
  return !result.valid;
}

/**
 * Validate the chat completion request
 */
export function validateRequest(body: unknown): ChatCompletionValidationResult {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body is required' };
  }

  const request = body as Record<string, unknown>;

  if (!request.model || typeof request.model !== 'string') {
    return { valid: false, error: 'model (agent_id) is required' };
  }

  if (!request.messages || !Array.isArray(request.messages)) {
    return { valid: false, error: 'messages array is required' };
  }

  if (request.messages.length === 0) {
    return { valid: false, error: 'messages array cannot be empty' };
  }

  // Validate each message has role and content
  for (let i = 0; i < request.messages.length; i++) {
    const msg = request.messages[i] as Record<string, unknown>;
    if (!msg.role || typeof msg.role !== 'string') {
      return { valid: false, error: `messages[${i}].role is required` };
    }
    if (!['system', 'user', 'assistant', 'tool'].includes(msg.role)) {
      return {
        valid: false,
        error: `messages[${i}].role must be one of: system, user, assistant, tool`,
      };
    }
    const toolCalls = msg.tool_calls;
    if (toolCalls === undefined) {
      continue;
    }
    if (!Array.isArray(toolCalls)) {
      return { valid: false, error: `messages[${i}].tool_calls must be an array` };
    }
    for (let callIndex = 0; callIndex < toolCalls.length; callIndex++) {
      const toolCall = toolCalls[callIndex];
      if (toolCall == null || typeof toolCall !== 'object') {
        continue;
      }
      const toolFunction = (toolCall as Record<string, unknown>).function;
      if (toolFunction == null || typeof toolFunction !== 'object') {
        continue;
      }
      const args = (toolFunction as Record<string, unknown>).arguments;
      if (args !== undefined && typeof args !== 'string') {
        return {
          valid: false,
          error: `messages[${i}].tool_calls[${callIndex}].function.arguments must be a string`,
        };
      }
    }
  }

  if (request.conversation_id !== undefined && typeof request.conversation_id !== 'string') {
    return { valid: false, error: 'conversation_id must be a string' };
  }
  if (request.code_environment_mode !== undefined || request.code_workspaces !== undefined) {
    return {
      valid: false,
      error:
        'code_environment_mode and code_workspaces are not supported by this service because it cannot enforce a persisted conversation decision',
    };
  }

  if (request.parent_message_id !== undefined && typeof request.parent_message_id !== 'string') {
    return { valid: false, error: 'parent_message_id must be a string' };
  }

  return { valid: true, request: request as unknown as ChatCompletionRequest };
}

/**
 * Build a non-streaming response from aggregated content
 */
export function buildNonStreamingResponse(
  context: OpenAIResponseContext,
  text: string,
  reasoning: string,
  toolCalls: Map<number, ToolCall>,
  usage: CompletionUsage,
  /** True when the map contains only accepted client-owned calls, not legacy run-step history. */
  acceptedToolCallsOnly = false,
): ChatCompletionResponse {
  const toolCallsArray = Array.from(toolCalls.values());
  const finishReason =
    toolCallsArray.length > 0 && (acceptedToolCallsOnly || !text) ? 'tool_calls' : 'stop';

  return {
    id: context.requestId,
    object: 'chat.completion',
    created: context.created,
    model: context.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(reasoning && { reasoning }),
          ...(toolCallsArray.length > 0 && { tool_calls: toolCallsArray }),
        },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}

/**
 * Main handler for OpenAI-compatible chat completions with agents.
 *
 * This function:
 * 1. Validates the request
 * 2. Looks up the agent by ID (model parameter)
 * 3. Initializes the agent with tools
 * 4. Runs the agent and streams/returns the response
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param deps - Dependencies for the service
 */
export async function createAgentChatCompletion(
  req: Request,
  res: ServerResponse,
  deps: ChatCompletionDependencies,
): Promise<void> {
  // Validate request
  const validation = validateRequest(req.body);
  if (isChatCompletionValidationFailure(validation)) {
    sendErrorResponse(res, 400, validation.error);
    return;
  }

  const request = validation.request;
  const agentId = request.model;
  const requestedStreaming = request.stream === true;
  const filters = deps.appConfig?.filters;
  const legacyPii = deps.appConfig?.messageFilter?.pii;
  const submittedMessages: readonly ExternalChatMessage[] = request.messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map<ExternalMessagePart>((part) => ({ ...part }))
      : (message.content ?? undefined),
  }));

  if (inspectSubmittedRequest(res, request, submittedMessages, filters, legacyPii)) {
    return;
  }

  // Look up the agent
  const agent = await deps.getAgent({ id: agentId });
  if (!agent) {
    sendErrorResponse(
      res,
      404,
      `Agent not found: ${agentId}`,
      'invalid_request_error',
      'model_not_found',
    );
    return;
  }

  // Generate IDs
  const requestId = `chatcmpl-${nanoid()}`;
  const conversationId = request.conversation_id ?? nanoid();
  let mcpParentMessageId: string | null | undefined;
  if (typeof request.parent_message_id === 'string' && request.parent_message_id.trim() !== '') {
    mcpParentMessageId = request.parent_message_id;
  } else if (request.conversation_id == null) {
    mcpParentMessageId = null;
  }
  const mcpRequestBody = createMCPRuntimeRequestBody({
    messageId: requestId,
    conversationId,
    parentMessageId: mcpParentMessageId,
  });
  const created = Math.floor(Date.now() / 1000);

  // Build response context
  const context: OpenAIResponseContext = {
    created,
    requestId,
    model: agentId,
  };

  // Set up abort controller
  const abortController = new AbortController();

  // Handle client disconnect
  req.on('close', () => {
    abortController.abort();
  });

  try {
    // Build allowed providers set (empty = all allowed)
    const allowedProviders = new Set<string>();

    /**
     * Derive `codeEnvAvailable` from the caller-supplied `appConfig` so
     * `agent.tools: ['execute_code']` still produces `bash_tool` +
     * `read_file` in the initialized agent's `toolDefinitions` (Phase 8
     * removed the legacy `execute_code` tool definition, so the
     * capability flag is the sole gate). Uses the
     * `AgentCapabilities.execute_code` enum value rather than a string
     * literal so an enum rename propagates here automatically. Falls
     * back to `undefined` when the caller doesn't provide `appConfig` —
     * matching the "explicit opt-in" semantics the in-repo controllers
     * use.
     */
    const agentsConfig = (deps.appConfig?.endpoints as Record<string, unknown> | undefined)?.agents;
    const capabilityEnabled = (capability: AgentCapabilities): boolean | undefined =>
      agentsConfig != null && typeof agentsConfig === 'object'
        ? ((agentsConfig as { capabilities?: string[] }).capabilities ?? []).includes(capability)
        : undefined;
    const capabilityAllowsCodeEnv = capabilityEnabled(AgentCapabilities.execute_code);
    /** Paired with the role grant when the embedder wires `getRoleByName`;
     *  `initializeAgent` rebuilds `bash_tool`, `read_file` and the workspace
     *  file tools from this flag, so a denied role would otherwise keep the
     *  code environment's file handlers. */
    const codeEnvAvailable =
      capabilityAllowsCodeEnv === true && deps.getRoleByName != null
        ? (await resolveToolRoleGrants({ req, getRoleByName: deps.getRoleByName })).runCode
        : capabilityAllowsCodeEnv;
    const capabilityAllowsFileSearch = capabilityEnabled(AgentCapabilities.file_search);
    /** The same pairing for the other gated tool, read only by the resend-file
     *  priming inside `initializeAgent`. The grant resolution is memoized on the
     *  request, so pairing both flags costs one role read. */
    const fileSearchAvailable =
      capabilityAllowsFileSearch === true && deps.getRoleByName != null
        ? (await resolveToolRoleGrants({ req, getRoleByName: deps.getRoleByName })).fileSearch
        : capabilityAllowsFileSearch;
    /** Wired whenever the embedder supplies `getRoleByName`, independent of
     *  `appConfig`: provider-native web search is a model parameter with no
     *  capability of its own, so the role grant is its only gate. */
    const { getRoleByName } = deps;
    const resolveWebSearchGrant =
      getRoleByName != null
        ? async () => (await resolveToolRoleGrants({ req, getRoleByName })).webSearch
        : undefined;
    /** Mirror `codeEnvAvailable` for the stateful-session gate so this route
     *  also carries each agent's trusted stateful endpoint/profile selection
     *  into tool loading and prewarming. */
    const statefulSessionsAvailable = capabilityEnabled(AgentCapabilities.stateful_code_sessions);
    const allowedStatefulCodeEnvironments =
      agentsConfig != null && typeof agentsConfig === 'object'
        ? (
            agentsConfig as {
              statefulCodeSessions?: {
                allowedEnvironments?: readonly StatefulCodeEnvironment[];
              };
            }
          ).statefulCodeSessions?.allowedEnvironments
        : undefined;
    /** Same gate as the in-repo controllers: without it, agents that opted
     *  tools in via tool_options.run_in_background silently lose the
     *  background param + poll tool on this route. */
    const backgroundToolsAvailable = capabilityEnabled(AgentCapabilities.run_in_background);
    /** Same gate for the injected `intent` label param. */
    const toolIntentsAvailable = capabilityEnabled(AgentCapabilities.tool_intents);
    const loadTools: InitializeAgentParams['loadTools'] = deps.loadAgentTools
      ? async (params) => {
          const result = await deps.loadAgentTools!({
            req,
            res,
            ...params,
            requestBody: mcpRequestBody,
          });
          return result as Awaited<ReturnType<NonNullable<CoreInitializeAgentParams['loadTools']>>>;
        }
      : undefined;

    // Initialize the agent first to check for disableStreaming
    const initializedAgent = await deps.initializeAgent({
      req,
      res,
      agent,
      conversationId,
      parentMessageId: request.parent_message_id,
      requestBody: mcpRequestBody,
      loadTools,
      endpointOption: {
        endpoint: agent.provider,
        model_parameters: agent.model_parameters ?? {},
      },
      allowedProviders,
      isInitialAgent: true,
      codeEnvAvailable,
      fileSearchAvailable,
      resolveWebSearchGrant,
      resolveLinkedInstructions: deps.resolveLinkedInstructions,
      recordLinkedPromptUsage: deps.recordLinkedPromptUsage,
      statefulSessionsAvailable,
      allowedStatefulCodeEnvironments,
      backgroundToolsAvailable,
      toolIntentsAvailable,
      signal: abortController.signal,
    });

    const modelBoundAgents = collectReachableAgents([initializedAgent]);
    const modelBoundFiles: InitializedFile[] = [];
    for (const modelBoundAgent of modelBoundAgents) {
      modelBoundFiles.push(
        ...(modelBoundAgent.attachments ?? []),
        ...(modelBoundAgent.requestAttachments ?? []),
        ...(modelBoundAgent.agentContextAttachments ?? []),
      );
    }
    assertModelBoundContent({
      onTraversalFailure: deps.onTraversalFailure,
      filters,
      legacyPii,
      submittedMessages,
      agents: modelBoundAgents,
      files: [...modelBoundFiles, ...getDynamicToolContexts(modelBoundAgents)],
    });

    // Determine if streaming is enabled (check both request and agent config)
    const streamingDisabled = !!(initializedAgent.model_parameters as Record<string, unknown>)
      ?.disableStreaming;
    const isStreaming = requestedStreaming && !streamingDisabled;

    // Create tracker for streaming or aggregator for non-streaming
    const tracker = isStreaming ? createOpenAIStreamTracker() : null;
    const aggregator = isStreaming ? null : createOpenAIContentAggregator();

    // Set up response headers for streaming
    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // Send initial chunk with role
      const initialChunk = createChunk(context, { role: 'assistant' });
      writeSSE(res, initialChunk);
    }

    // Create handler config (only used for streaming)
    const handlerConfig: OpenAIStreamWriterConfig | null =
      isStreaming && tracker
        ? {
            writer: res,
            context,
            tracker,
          }
        : null;

    // Create event handlers
    const eventHandlers = createOpenAIHandlers(
      handlerConfig
        ? { ...handlerConfig, signal: abortController.signal }
        : {
            aggregator: aggregator!,
            signal: abortController.signal,
          },
      deps.toolExecuteOptions == null
        ? undefined
        : {
            ...deps.toolExecuteOptions,
            runSignal: abortController.signal,
            foregroundRunId: requestId,
          },
    );

    // Convert messages to internal format
    const messages = convertMessages(request.messages);

    // Create and run the agent
    if (deps.createRun) {
      const reqUser = (req as unknown as { user?: Parameters<typeof createSafeUser>[0] }).user;
      const userId = reqUser?.id ?? 'api-user';
      /**
       * Propagate the full safe user (id + role), matching the in-repo agent
       * controllers (responses.js / openai.js). The runtime MCP permission
       * check reads `configurable.user`; passing only `user_id` would make
       * every MCP tool call fail closed for an authenticated caller. When the
       * host app didn't attach a user, this falls back to a bare id, which
       * correctly leaves MCP gated.
       */
      const safeUser: Record<string, unknown> = { ...createSafeUser(reqUser), id: userId };
      const run = await deps.createRun({
        agents: [initializedAgent],
        messages,
        runId: requestId,
        signal: abortController.signal,
        customHandlers: eventHandlers,
        requestBody: mcpRequestBody,
        user: safeUser,
        traceContext: { endpoint: EModelEndpoint.agents },
        tenantId: typeof reqUser?.tenantId === 'string' ? reqUser.tenantId : undefined,
        appConfig: selectCreateRunAppConfig(deps.appConfig),
      });

      if (run) {
        const target = tracker ?? aggregator!;
        await completeOpenAIToolCalls(
          {
            finish: () => target.finishToolCalls?.(),
            abort: () => target.abortToolCalls?.(),
          },
          () =>
            run.processStream(
              { messages },
              {
                runName: 'AgentRun',
                configurable: {
                  thread_id: conversationId,
                  user_id: userId,
                  user: safeUser,
                  requestBody: mcpRequestBody,
                  /** Same per-agent channel the in-repo controllers thread via
                   *  `loadTools`: without it, the executor's PTC path cannot
                   *  strip host-injected `intent` params from the schemas the
                   *  sandbox bridge advertises on this route. */
                  ...(initializedAgent.intentToolNames?.length
                    ? { intentToolNames: initializedAgent.intentToolNames }
                    : {}),
                },
                recursionLimit: resolveRecursionLimit(
                  agentsConfig as Partial<TAgentsEndpoint> | undefined,
                  initializedAgent,
                ),
                signal: abortController.signal,
                streamMode: 'values',
                version: 'v2',
              },
              {},
            ),
        );
      }
    }

    // Finalize response
    if (isStreaming && handlerConfig) {
      sendFinalChunk(handlerConfig, 'stop', undefined, true);
      res.end();
    } else if (aggregator) {
      aggregator.finishToolCalls?.();
      // Build and send non-streaming response
      const usage: CompletionUsage = {
        prompt_tokens: aggregator.usage.promptTokens,
        completion_tokens: aggregator.usage.completionTokens,
        total_tokens: aggregator.usage.promptTokens + aggregator.usage.completionTokens,
        ...(aggregator.usage.reasoningTokens > 0 && {
          completion_tokens_details: { reasoning_tokens: aggregator.usage.reasoningTokens },
        }),
      };
      const response = buildNonStreamingResponse(
        context,
        aggregator.getText(),
        aggregator.getReasoning(),
        aggregator.toolCalls,
        usage,
        true,
      );
      res.json(response);
    }
  } catch (error) {
    if (isContentFilterError(error) && !res.headersSent) {
      sendErrorResponse(
        res,
        error.statusCode,
        error.body.message,
        'invalid_request_error',
        error.body.error,
      );
      return;
    }
    const errorMessage = getUserFacingProviderError(
      error,
      hasModelBoundContentProtection(filters, legacyPii),
    );
    // Check if we already started streaming (headers sent)
    if (res.headersSent) {
      // Headers already sent, try to send error in stream format
      const errorChunk = createChunk(context, { content: `\n\nError: ${errorMessage}` }, 'stop');
      writeSSE(res, errorChunk);
      writeSSE(res, '[DONE]');
      res.end();
    } else {
      const candidateStatus =
        error != null && typeof error === 'object'
          ? ((error as { status?: unknown; statusCode?: unknown }).status ??
            (error as { statusCode?: unknown }).statusCode)
          : undefined;
      const statusCode =
        typeof candidateStatus === 'number' &&
        Number.isInteger(candidateStatus) &&
        candidateStatus >= 400 &&
        candidateStatus < 600
          ? candidateStatus
          : 500;
      const errorType =
        statusCode >= 400 && statusCode < 500 ? 'invalid_request_error' : 'server_error';
      const errorCode =
        error != null &&
        typeof error === 'object' &&
        typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : null;
      sendErrorResponse(res, statusCode, errorMessage, errorType, errorCode);
    }
  }
}

/**
 * List available agents/models
 *
 * This provides a /v1/models compatible endpoint that lists available agents.
 */
export async function listAgentModels(
  _req: Request,
  res: ServerResponse,
  deps: { getAgents: (params: Record<string, unknown>) => Promise<Agent[]> },
): Promise<void> {
  try {
    const agents = await deps.getAgents({});

    const models = agents.map((agent) => ({
      id: agent.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'librechat',
      permission: [],
      root: agent.id,
      parent: null,
      // Extensions
      name: agent.name,
      provider: agent.provider,
    }));

    res.json({
      object: 'list',
      data: models,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to list models';
    sendErrorResponse(res, 500, errorMessage, 'server_error');
  }
}

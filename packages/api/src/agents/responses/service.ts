/**
 * Open Responses API Service
 *
 * Core service for processing Open Responses API requests.
 * Handles input conversion, message formatting, and request validation.
 */
import {
  ContentTypes,
  isCodeEnvironmentMode,
  isCodeWorkspaceSelections,
} from 'librechat-data-provider';
import type { Response as ServerResponse } from 'express';
import type {
  FunctionCallOutputItemParam,
  RequestValidationResult,
  FunctionCallItemParam,
  ResponseRequest,
  ResponseContext,
  InputContent,
  ModelContent,
  InputItem,
  Response,
  Usage,
} from './types';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import {
  writeDone,
  emitResponseCompleted,
  emitMessageItemAdded,
  emitMessageItemDone,
  emitTextContentPartAdded,
  emitOutputTextDelta,
  emitOutputTextDone,
  emitTextContentPartDone,
  emitFunctionCallItemAdded,
  emitFunctionCallArgumentsDelta,
  emitFunctionCallArgumentsDone,
  emitFunctionCallItemDone,
  emitFunctionCallOutputItem,
  emitReasoningItemAdded,
  emitReasoningContentPartAdded,
  emitReasoningDelta,
  emitReasoningDone,
  emitReasoningContentPartDone,
  emitReasoningItemDone,
  type StreamHandlerConfig,
} from './handlers';
import { declaredClientToolNames, validateClientTools } from './clientTools';
import { aggregateCollectedUsage } from '../usage';

interface ResponseUsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

interface ModelUsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    cache_creation?: number;
    cache_read?: number;
  };
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function accumulateResponseUsage(
  target: ResponseUsageAccumulator,
  usage: ModelUsageMetadata,
): void {
  target.inputTokens += usage.input_tokens ?? 0;
  target.outputTokens += usage.output_tokens ?? 0;
  target.cachedTokens +=
    (usage.input_token_details?.cache_read ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

/* =============================================================================
 * REQUEST VALIDATION
 * ============================================================================= */

/**
 * Validate a request body
 */
export function validateResponseRequest(body: unknown): RequestValidationResult {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body is required' };
  }

  const request = body as Record<string, unknown>;
  if (
    request.code_environment_mode !== undefined &&
    !isCodeEnvironmentMode(request.code_environment_mode)
  ) {
    return { valid: false, error: 'code_environment_mode is invalid' };
  }
  if (
    request.code_workspaces !== undefined &&
    !isCodeWorkspaceSelections(request.code_workspaces)
  ) {
    return {
      valid: false,
      error: 'code_workspaces must contain unique environment/workspace selections',
    };
  }

  // Required: model
  if (!request.model || typeof request.model !== 'string') {
    return { valid: false, error: 'model is required and must be a string' };
  }

  // Required: input (string or array)
  if (request.input === undefined || request.input === null) {
    return { valid: false, error: 'input is required' };
  }

  if (typeof request.input !== 'string' && !Array.isArray(request.input)) {
    return { valid: false, error: 'input must be a string or array of items' };
  }

  // Optional validations
  if (request.stream !== undefined && typeof request.stream !== 'boolean') {
    return { valid: false, error: 'stream must be a boolean' };
  }

  if (request.temperature !== undefined) {
    const temp = request.temperature as number;
    if (typeof temp !== 'number' || temp < 0 || temp > 2) {
      return { valid: false, error: 'temperature must be a number between 0 and 2' };
    }
  }

  if (request.max_output_tokens !== undefined) {
    if (typeof request.max_output_tokens !== 'number' || request.max_output_tokens < 1) {
      return { valid: false, error: 'max_output_tokens must be a positive number' };
    }
  }

  if (
    request.previous_response_id !== undefined &&
    typeof request.previous_response_id !== 'string'
  ) {
    return { valid: false, error: 'previous_response_id must be a string' };
  }

  const clientToolsError = validateClientTools(request.tools);
  if (clientToolsError !== undefined) {
    return { valid: false, error: clientToolsError };
  }

  if (Array.isArray(request.input)) {
    const toolExchangeError = validateInputToolExchanges(
      request.input as InputItem[],
      declaredClientToolNames(request.tools),
    );
    if (toolExchangeError !== undefined) {
      return { valid: false, error: toolExchangeError };
    }
  }

  return { valid: true, request: request as unknown as ResponseRequest };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * Validates the replayed tool exchanges in `input`.
 *
 * A turn is persisted as text, so `previous_response_id` does not carry a tool
 * exchange: replaying the `function_call` together with its
 * `function_call_output` is the only supported continuation. For a tool the
 * caller executes, both halves are therefore required, and an unpaired half is
 * the caller's error rather than something to hand to the provider — an
 * unanswered tool call reaches the model as a malformed conversation and comes
 * back as an opaque upstream failure.
 *
 * A call to a tool the *server* owns is not held to that rule. The server emits
 * a `function_call` for its own tools but no `function_call_output`, so the
 * usual continuation — appending the previous response's `output` to the next
 * request's `input` — carries calls the caller cannot answer and never could.
 * Those are dropped in {@link convertInputToMessages} instead of refused here.
 *
 * @returns An error message, or `undefined` when every exchange is well formed.
 */
export function validateInputToolExchanges(
  input: InputItem[],
  clientToolNames: ReadonlySet<string> = new Set<string>(),
): string | undefined {
  const callIds = new Set<string>();
  const clientCallIds = new Set<string>();
  const outputCallIds = new Set<string>();

  for (const item of input) {
    if (item == null || typeof item !== 'object') {
      continue;
    }

    if (item.type === 'function_call') {
      const call = item as Partial<FunctionCallItemParam>;
      if (!isNonEmptyString(call.call_id)) {
        return 'each function_call requires a non-empty string call_id';
      }
      if (!isNonEmptyString(call.name)) {
        return `function_call ${call.call_id} requires a non-empty string name`;
      }
      if (typeof call.arguments !== 'string') {
        return `function_call ${call.call_id} requires arguments as a JSON string`;
      }
      if (callIds.has(call.call_id)) {
        return `duplicate function_call call_id: ${call.call_id}`;
      }
      callIds.add(call.call_id);
      if (clientToolNames.has(call.name)) {
        clientCallIds.add(call.call_id);
      }
      continue;
    }

    if (item.type === 'function_call_output') {
      const output = item as Partial<FunctionCallOutputItemParam>;
      if (!isNonEmptyString(output.call_id)) {
        return 'each function_call_output requires a non-empty string call_id';
      }
      if (typeof output.output !== 'string') {
        return `function_call_output ${output.call_id} requires output as a string`;
      }
      if (outputCallIds.has(output.call_id)) {
        return `duplicate function_call_output call_id: ${output.call_id}`;
      }
      outputCallIds.add(output.call_id);
    }
  }

  for (const callId of clientCallIds) {
    if (!outputCallIds.has(callId)) {
      return `function_call ${callId} has no function_call_output in input; replay both items to continue a tool exchange`;
    }
  }

  for (const callId of outputCallIds) {
    if (!callIds.has(callId)) {
      return `function_call_output ${callId} has no matching function_call in input`;
    }
  }

  return undefined;
}

/**
 * Check if validation failed
 */
export function isValidationFailure(
  result: RequestValidationResult,
): result is { valid: false; error: string } {
  return !result.valid;
}

/* =============================================================================
 * INPUT CONVERSION
 * ============================================================================= */

/** A replayed tool exchange, in the content-part shape LibreChat persists. */
export interface InternalToolCallPart {
  type: ContentTypes.TOOL_CALL;
  tool_call: {
    id: string;
    name: string;
    /** Raw JSON string as the caller sent it; `formatAgentMessages` parses it. */
    args: string;
    /** The caller's result for this call. Present on every replayed pair. */
    output: string;
  };
}

/**
 * Internal message format (LibreChat-compatible).
 *
 * There is deliberately no `tool` role and no `tool_call_id`: a tool result
 * belongs to the `tool_call` part of the assistant turn that made the call.
 * `formatMessage` has no branch for a tool role, so such a message formats as a
 * SystemMessage and breaks the conversation for providers that accept a system
 * message only in first position.
 */
export interface InternalMessage {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<{ type: string; text?: string; image_url?: unknown } | InternalToolCallPart>;
  name?: string;
}

/**
 * Convert Open Responses input to internal message format.
 * Handles both string input and array of items.
 */
export function convertInputToMessages(input: string | InputItem[]): InternalMessage[] {
  // Simple string input becomes a user message
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }

  const messages: InternalMessage[] = [];
  const outputsByCallId = collectFunctionCallOutputs(input);
  /**
   * The assistant message collecting the current run of consecutive
   * `function_call` items. A parallel batch arrives as several calls in a row
   * and belongs on ONE assistant turn, so providers that pair tool results
   * against the calls of a single turn see the batch as it was issued.
   */
  let pendingToolCallMessage: InternalMessage | null = null;

  for (const item of input) {
    if (item.type === 'item_reference') {
      // Skip item references - they're handled by previous_response_id
      continue;
    }

    if (item.type !== 'function_call') {
      pendingToolCallMessage = null;
    }

    if (item.type === 'message') {
      const messageItem = item as {
        type: 'message';
        role: string;
        content: string | (InputContent | ModelContent)[];
      };

      let content: InternalMessage['content'];

      if (typeof messageItem.content === 'string') {
        content = messageItem.content;
      } else if (Array.isArray(messageItem.content)) {
        content = messageItem.content
          .filter((part): part is InputContent | ModelContent => part != null)
          .map((part) => {
            if (part.type === 'input_text' || part.type === 'output_text') {
              return { type: 'text', text: (part as { text?: string }).text ?? '' };
            }
            if (part.type === 'refusal') {
              return { type: 'text', text: (part as { refusal?: string }).refusal ?? '' };
            }
            if (part.type === 'input_image') {
              return {
                type: 'image_url',
                image_url: {
                  url: (part as { image_url?: string }).image_url,
                  detail: (part as { detail?: string }).detail,
                },
              };
            }
            if (part.type === 'input_file') {
              const filePart = part as { filename?: string };
              return { type: 'text', text: `[File: ${filePart.filename ?? 'unknown'}]` };
            }
            return null;
          })
          .filter((part): part is NonNullable<typeof part> => part != null);
      } else {
        content = '';
      }

      // Map developer role to system (LibreChat convention)
      let role: InternalMessage['role'];
      if (messageItem.role === 'developer') {
        role = 'system';
      } else if (messageItem.role === 'user') {
        role = 'user';
      } else if (messageItem.role === 'assistant') {
        role = 'assistant';
      } else if (messageItem.role === 'system') {
        role = 'system';
      } else {
        role = 'user';
      }

      messages.push({ role, content });
    }

    /**
     * A replayed call and its result become ONE `tool_call` content part on an
     * assistant message, which is how LibreChat persists a tool exchange and
     * the only shape `formatAgentMessages` reads: it emits the provider's
     * tool-use block from the part and the paired tool result from
     * `tool_call.output`. The OpenAI-style `{ role: 'tool' }` message this
     * used to produce has no branch in `formatMessage`, which turned it into a
     * SystemMessage mid-conversation — rejected outright by providers that
     * allow a system message only as the first one.
     *
     * `function_call_output` items are consumed here through `outputsByCallId`,
     * not emitted on their own; ingress validation has already established
     * that a caller-executed call has exactly one output and vice versa.
     *
     * A call with no output is one of the server's own, replayed from a
     * previous response that never carried a result for it. It is dropped:
     * replaying it with an empty result would put an unanswered tool call in
     * front of the provider, which is what the pairing rule exists to prevent.
     */
    if (item.type === 'function_call') {
      const fcItem = item as FunctionCallItemParam;
      const output = outputsByCallId.get(fcItem.call_id);
      if (output === undefined) {
        continue;
      }
      const part: InternalToolCallPart = {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: fcItem.call_id,
          name: fcItem.name,
          args: fcItem.arguments,
          output,
        },
      };

      if (pendingToolCallMessage != null && Array.isArray(pendingToolCallMessage.content)) {
        pendingToolCallMessage.content.push(part);
      } else {
        pendingToolCallMessage = { role: 'assistant', content: [part] };
        messages.push(pendingToolCallMessage);
      }
    }

    // Reasoning items are typically not passed back as input
    // They're model-generated and may be encrypted
  }

  return messages;
}

/** Indexes every `function_call_output` in the input by its `call_id`. */
function collectFunctionCallOutputs(input: InputItem[]): Map<string, string> {
  const outputs = new Map<string, string>();
  for (const item of input) {
    if (item.type === 'function_call_output') {
      const fcoItem = item as FunctionCallOutputItemParam;
      outputs.set(fcoItem.call_id, fcoItem.output);
    }
  }
  return outputs;
}

/**
 * Merge previous conversation messages with new input
 */
export function mergeMessagesWithInput(
  previousMessages: InternalMessage[],
  newInput: InternalMessage[],
): InternalMessage[] {
  return [...previousMessages, ...newInput];
}

/* =============================================================================
 * ERROR RESPONSE
 * ============================================================================= */

/**
 * Send an error response in Open Responses format
 */
export function sendResponsesErrorResponse(
  res: ServerResponse,
  statusCode: number,
  message: string,
  type: string = 'invalid_request',
  code?: string,
): void {
  res.status(statusCode).json({
    error: {
      type,
      message,
      code: code ?? null,
      param: null,
    },
  });
}

/* =============================================================================
 * RESPONSE CONTEXT
 * ============================================================================= */

/**
 * Generate a unique response ID
 */
export function generateResponseId(): string {
  return `resp_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Create a response context from request
 */
export function createResponseContext(
  request: ResponseRequest,
  responseId?: string,
): ResponseContext {
  return {
    responseId: responseId ?? generateResponseId(),
    model: request.model,
    createdAt: Math.floor(Date.now() / 1000),
    previousResponseId: request.previous_response_id,
    instructions: request.instructions,
  };
}

/* =============================================================================
 * STREAMING SETUP
 * ============================================================================= */

/**
 * Set up streaming response headers
 */
export function setupStreamingResponse(res: ServerResponse): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

/* =============================================================================
 * STREAM HANDLER FACTORY
 * ============================================================================= */

/**
 * State for tracking streaming progress
 */
interface StreamState {
  messageStarted: boolean;
  messageContentStarted: boolean;
  reasoningStarted: boolean;
  reasoningContentStarted: boolean;
  activeToolCalls: Set<string>;
  completedToolCalls: Set<string>;
  /** Calls to a caller-executed tool — the subset the run has to terminate itself. */
  clientToolCalls: Set<string>;
}

/** One streamed argument fragment, as the agents SDK forwards LangChain tool call chunks. */
interface ToolCallChunk {
  id?: string;
  index?: number;
  args?: string;
}

/**
 * Arguments as they appear on a completed model message, keyed by call id.
 *
 * The agents SDK only streams argument fragments when the provider sends the call in pieces; a
 * call that arrives whole is dispatched with its arguments already parsed and no deltas follow.
 * The completed message carries both cases, so it is the reliable source for any call whose
 * arguments never arrived as fragments.
 */
function completedToolCallArguments(data: unknown): Array<{ id: string; args: string }> {
  const endData = data as { output?: { tool_calls?: Array<{ id?: string; args?: unknown }> } };
  const toolCalls = endData?.output?.tool_calls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  const resolved: Array<{ id: string; args: string }> = [];
  for (const tc of toolCalls) {
    const id = tc.id ?? '';
    if (!id || tc.args == null) {
      continue;
    }
    resolved.push({ id, args: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args) });
  }
  return resolved;
}

interface ToolCallChunkResolver {
  registerStep: (stepId: string, callIds: string[]) => void;
  resolve: (stepId: string, chunk: ToolCallChunk) => string | undefined;
}

/**
 * Matches a streamed argument fragment to the tool call it belongs to.
 *
 * A chunk's `index` is provider-relative: Anthropic numbers content blocks, so thinking and text
 * blocks consume values, and the numbering restarts on every step. It is therefore not an offset
 * into the run's tool calls, and using it as one appends arguments to the wrong call as soon as a
 * run makes more than one. Chunks are matched by id, falling back to the index recorded alongside
 * that id within the same step, and finally to a step that holds exactly one call.
 */
function createToolCallChunkResolver(): ToolCallChunkResolver {
  const indexToCallId = new Map<string, Map<number, string>>();
  const stepCallIds = new Map<string, string[]>();

  return {
    registerStep: (stepId: string, callIds: string[]): void => {
      stepCallIds.set(stepId, callIds);
    },

    resolve: (stepId: string, chunk: ToolCallChunk): string | undefined => {
      let byIndex = indexToCallId.get(stepId);
      if (!byIndex) {
        byIndex = new Map<number, string>();
        indexToCallId.set(stepId, byIndex);
      }

      if (chunk.id != null && chunk.id !== '') {
        if (chunk.index != null) {
          byIndex.set(chunk.index, chunk.id);
        }
        return chunk.id;
      }

      if (chunk.index != null) {
        const mapped = byIndex.get(chunk.index);
        if (mapped != null) {
          return mapped;
        }
      }

      const callIds = stepCallIds.get(stepId);
      return callIds?.length === 1 ? callIds[0] : undefined;
    },
  };
}

/**
 * Create LibreChat event handlers that emit Open Responses events
 */
export function createResponsesEventHandlers(config: StreamHandlerConfig): {
  handlers: Record<string, { handle: (event: string, data: unknown) => void }>;
  state: StreamState;
  finalizeStream: (usage?: Usage) => void;
  emitClientToolDeferral: (callId: string, output: string) => void;
} {
  const state: StreamState = {
    messageStarted: false,
    messageContentStarted: false,
    reasoningStarted: false,
    reasoningContentStarted: false,
    activeToolCalls: new Set(),
    completedToolCalls: new Set(),
    clientToolCalls: new Set(),
  };

  const chunkResolver = createToolCallChunkResolver();
  let modelEndedClientCalls: Set<string> | undefined;
  let pendingClientToolDeferrals: Map<string, string> | undefined;

  /**
   * Ensure message item is started
   */
  const ensureMessageStarted = (): void => {
    if (!state.messageStarted) {
      emitMessageItemAdded(config);
      state.messageStarted = true;
    }
  };

  /**
   * Ensure message content part is started
   */
  const ensureMessageContentStarted = (): void => {
    ensureMessageStarted();
    if (!state.messageContentStarted) {
      emitTextContentPartAdded(config);
      state.messageContentStarted = true;
    }
  };

  /**
   * Ensure reasoning item is started
   */
  const ensureReasoningStarted = (): void => {
    if (!state.reasoningStarted) {
      emitReasoningItemAdded(config);
      state.reasoningStarted = true;
    }
  };

  /**
   * Ensure reasoning content part is started
   */
  const ensureReasoningContentStarted = (): void => {
    ensureReasoningStarted();
    if (!state.reasoningContentStarted) {
      emitReasoningContentPartAdded(config);
      state.reasoningContentStarted = true;
    }
  };

  /**
   * Closes a caller-executed call that the server answered itself, and emits
   * the answer as a `function_call_output` item.
   *
   * Without the output item the call is indistinguishable from one handed back
   * for the caller to run, so a caller would execute a tool the model was told
   * to re-issue — and a side-effecting tool would run twice.
   */
  const deliverClientToolDeferral = (callId: string, output: string): void => {
    if (state.completedToolCalls.has(callId)) {
      return;
    }
    state.completedToolCalls.add(callId);
    emitFunctionCallArgumentsDone(config, callId);
    emitFunctionCallItemDone(config, callId);
    emitFunctionCallOutputItem(config, callId, output);
  };

  const emitClientToolDeferral = (callId: string, output: string): void => {
    if (!state.activeToolCalls.has(callId) || state.completedToolCalls.has(callId)) {
      return;
    }
    // A tool-execute event can beat the model-end event that contains the
    // authoritative arguments. Keep the result pending until they arrive.
    if (modelEndedClientCalls?.has(callId)) {
      deliverClientToolDeferral(callId, output);
      return;
    }
    (pendingClientToolDeferrals ??= new Map()).set(callId, output);
  };

  /**
   * Terminate the still-open calls to a caller-executed tool.
   *
   * `on_tool_end` terminates a call the server ran, which a caller-executed
   * tool never is — the whole point is that the server hands it back. Without
   * this, a streaming caller gets `output_item.added` plus argument deltas and
   * then `response.completed`, with no `function_call_arguments.done` to mark
   * the arguments final, and the item it is expected to act on stays
   * `in_progress` inside a response that claims to be completed. A caller that
   * waits for the terminating event before running the tool, as the streaming
   * lifecycle tells it to, would wait forever.
   *
   * Deliberately limited to those calls. A server tool left open is the
   * separate, pre-existing symptom of `on_tool_end` never reaching this module
   * (the controller replaces the handler rather than composing with it); fixing
   * that belongs at the wiring, not here, and closing such calls from
   * finalization would change the event stream of every request that declares
   * no client tool.
   *
   * Idempotent in both directions: a call already closed by `on_tool_end` is
   * skipped, and marking it closed keeps `on_tool_end` from emitting a second
   * pair afterwards. Arguments are complete by this point — `on_chat_model_end`
   * backfills a delta for any call whose arguments the provider sent whole
   * rather than streamed.
   */
  const closeOpenClientToolCalls = (): void => {
    for (const callId of state.clientToolCalls) {
      if (state.completedToolCalls.has(callId)) {
        continue;
      }
      state.completedToolCalls.add(callId);
      emitFunctionCallArgumentsDone(config, callId);
      emitFunctionCallItemDone(config, callId);
    }
  };

  /**
   * Close any open content streams
   */
  const closeOpenStreams = (): void => {
    // Close message content if open
    if (state.messageContentStarted) {
      emitOutputTextDone(config);
      emitTextContentPartDone(config);
      state.messageContentStarted = false;
    }

    // Close message item if open
    if (state.messageStarted) {
      emitMessageItemDone(config);
      state.messageStarted = false;
    }

    // Close reasoning content if open
    if (state.reasoningContentStarted) {
      emitReasoningDone(config);
      emitReasoningContentPartDone(config);
      state.reasoningContentStarted = false;
    }

    // Close reasoning item if open
    if (state.reasoningStarted) {
      emitReasoningItemDone(config);
      state.reasoningStarted = false;
    }
  };

  const handlers = {
    /**
     * Handle text message deltas
     */
    on_message_delta: {
      handle: (_event: string, data: unknown): void => {
        const deltaData = data as { delta?: { content?: Array<{ type: string; text?: string }> } };
        const content = deltaData?.delta?.content;

        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === 'text' && part.text) {
              ensureMessageContentStarted();
              emitOutputTextDelta(config, part.text);
            }
          }
        }
      },
    },

    /**
     * Handle reasoning deltas
     */
    on_reasoning_delta: {
      handle: (_event: string, data: unknown): void => {
        const deltaData = data as {
          delta?: { content?: Array<{ type: string; text?: string; think?: string }> };
        };
        const content = deltaData?.delta?.content;

        if (Array.isArray(content)) {
          for (const part of content) {
            const text = part.think || part.text;
            if (text) {
              ensureReasoningContentStarted();
              emitReasoningDelta(config, text);
            }
          }
        }
      },
    },

    /**
     * Handle run step (tool call initiation)
     */
    on_run_step: {
      handle: (_event: string, data: unknown): void => {
        const stepData = data as {
          id?: string;
          stepDetails?: { type: string; tool_calls?: Array<{ id?: string; name?: string }> };
        };
        const stepDetails = stepData?.stepDetails;

        if (stepDetails?.type === 'tool_calls' && stepDetails.tool_calls) {
          // Close any open message/reasoning before tool calls
          closeOpenStreams();

          const stepCallIds: string[] = [];
          for (const tc of stepDetails.tool_calls) {
            const callId = tc.id ?? '';
            const name = tc.name ?? '';

            if (!callId) {
              continue;
            }

            stepCallIds.push(callId);
            if (!state.activeToolCalls.has(callId)) {
              state.activeToolCalls.add(callId);
              /* Recorded at announcement, while the name is in hand: the
                 terminating events are emitted much later, from finalization,
                 where only the call id is available. */
              if (config.clientToolNames?.has(name) === true) {
                state.clientToolCalls.add(callId);
              }
              emitFunctionCallItemAdded(config, callId, name);
            }
          }
          chunkResolver.registerStep(stepData?.id ?? '', stepCallIds);
        }
      },
    },

    /**
     * Handle run step delta (tool call argument streaming)
     */
    on_run_step_delta: {
      handle: (_event: string, data: unknown): void => {
        const deltaData = data as {
          id?: string;
          delta?: { type: string; tool_calls?: ToolCallChunk[] };
        };
        const delta = deltaData?.delta;

        if (delta?.type === 'tool_calls' && delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            // Resolved before the empty-args check so an id-bearing opening chunk is recorded.
            const callId = chunkResolver.resolve(deltaData?.id ?? '', tc);
            const args = typeof tc.args === 'string' ? tc.args : '';
            if (!args || !callId) {
              continue;
            }

            emitFunctionCallArgumentsDelta(config, callId, args);
          }
        }
      },
    },

    /**
     * Handle tool end (tool execution complete)
     */
    on_tool_end: {
      handle: (_event: string, data: unknown): void => {
        const toolData = data as { tool_call_id?: string; output?: string };
        const callId = toolData?.tool_call_id;
        const output = toolData?.output ?? '';

        if (callId && state.activeToolCalls.has(callId) && !state.completedToolCalls.has(callId)) {
          state.completedToolCalls.add(callId);

          // Complete the function call item
          emitFunctionCallArgumentsDone(config, callId);
          emitFunctionCallItemDone(config, callId);

          // Emit the function call output (internal tool result)
          emitFunctionCallOutputItem(config, callId, output);
        }
      },
    },

    /**
     * Handle chat model end (usage collection)
     */
    on_chat_model_end: {
      handle: (_event: string, data: unknown): void => {
        const endData = data as {
          output?: {
            usage_metadata?: ModelUsageMetadata;
          };
        };

        const usage = endData?.output?.usage_metadata;
        if (usage) {
          accumulateResponseUsage(config.tracker.usage, usage);
        }

        for (const { id, args } of completedToolCallArguments(data)) {
          if (!state.activeToolCalls.has(id)) {
            continue;
          }
          const streamed = config.tracker.accumulatedArguments.get(id) ?? '';
          // An early handoff mark changes the SDK's step key. If a later
          // index-only chunk lands on that new step, recover just the missing
          // suffix without duplicating fragments already sent over SSE.
          if (args.startsWith(streamed) && args.length > streamed.length) {
            emitFunctionCallArgumentsDelta(config, id, args.slice(streamed.length));
          }
          if (state.clientToolCalls.has(id)) {
            (modelEndedClientCalls ??= new Set()).add(id);
            const deferred = pendingClientToolDeferrals?.get(id);
            if (deferred !== undefined) {
              pendingClientToolDeferrals?.delete(id);
              deliverClientToolDeferral(id, deferred);
            }
          }
        }
      },
    },
  };

  /**
   * Finalize the stream - close open items and emit completed
   */
  const finalizeStream = (usage?: Usage): void => {
    closeOpenStreams();
    for (const [callId, output] of pendingClientToolDeferrals ?? []) {
      deliverClientToolDeferral(callId, output);
    }
    // A later step can announce a sibling before its arguments or deferral
    // are settled. Only terminate handoffs after the run has completed.
    closeOpenClientToolCalls();
    emitResponseCompleted(config, usage);
    writeDone(config.res);
  };

  return { handlers, state, finalizeStream, emitClientToolDeferral };
}

/* =============================================================================
 * NON-STREAMING AGGREGATOR
 * ============================================================================= */

/**
 * Aggregator for non-streaming responses
 */
export interface ResponseAggregator {
  textChunks: string[];
  reasoningChunks: string[];
  toolCalls: Map<
    string,
    {
      id: string;
      name: string;
      arguments: string;
    }
  >;
  toolOutputs: Map<string, string>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedTokens: number;
  };
  addText: (text: string) => void;
  addReasoning: (text: string) => void;
  getText: () => string;
  getReasoning: () => string;
}

/**
 * Create an aggregator for non-streaming responses
 */
export function createResponseAggregator(): ResponseAggregator {
  const aggregator: ResponseAggregator = {
    textChunks: [],
    reasoningChunks: [],
    toolCalls: new Map(),
    toolOutputs: new Map(),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
    },
    addText: (text: string) => {
      aggregator.textChunks.push(text);
    },
    addReasoning: (text: string) => {
      aggregator.reasoningChunks.push(text);
    },
    getText: () => aggregator.textChunks.join(''),
    getReasoning: () => aggregator.reasoningChunks.join(''),
  };
  return aggregator;
}

/**
 * Build a non-streaming response from aggregator
 * Includes all required fields per Open Responses spec
 */
export function buildAggregatedResponse(
  context: ResponseContext,
  aggregator: ResponseAggregator,
  usageOverride?: Usage,
): Response {
  const output: Response['output'] = [];

  // Add reasoning item if present
  const reasoningText = aggregator.getReasoning();
  if (reasoningText) {
    output.push({
      type: 'reasoning',
      id: `reason_${Date.now().toString(36)}`,
      status: 'completed',
      content: [{ type: 'reasoning_text', text: reasoningText }],
      summary: [],
    });
  }

  // Add function calls and outputs
  for (const [callId, tc] of aggregator.toolCalls) {
    output.push({
      type: 'function_call',
      id: `fc_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 6)}`,
      call_id: callId,
      name: tc.name,
      arguments: tc.arguments,
      status: 'completed',
    });

    const toolOutput = aggregator.toolOutputs.get(callId);
    if (toolOutput) {
      output.push({
        type: 'function_call_output',
        id: `fco_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 6)}`,
        call_id: callId,
        output: toolOutput,
        status: 'completed',
      });
    }
  }

  // Add message item if there's text (or always add one if no other output)
  const text = aggregator.getText();
  if (text || output.length === 0) {
    output.push({
      type: 'message',
      id: `msg_${Date.now().toString(36)}`,
      role: 'assistant',
      status: 'completed',
      content: text ? [{ type: 'output_text', text, annotations: [], logprobs: [] }] : [],
    });
  }

  return {
    // Required fields per Open Responses spec
    id: context.responseId,
    object: 'response',
    created_at: context.createdAt,
    completed_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    incomplete_details: null,
    model: context.model,
    previous_response_id: context.previousResponseId ?? null,
    instructions: context.instructions ?? null,
    output,
    error: null,
    tools: context.tools ?? [],
    /** Not forwarded to the model, so reporting the request's ask would misstate the run. */
    tool_choice: 'auto',
    truncation: 'disabled',
    parallel_tool_calls: true,
    text: { format: { type: 'text' } },
    temperature: 1,
    top_p: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    top_logprobs: 0,
    reasoning: null,
    user: null,
    usage: usageOverride ?? {
      input_tokens: aggregator.usage.inputTokens,
      output_tokens: aggregator.usage.outputTokens,
      total_tokens: aggregator.usage.inputTokens + aggregator.usage.outputTokens,
      input_tokens_details: { cached_tokens: aggregator.usage.cachedTokens },
      output_tokens_details: { reasoning_tokens: aggregator.usage.reasoningTokens },
    },
    max_output_tokens: null,
    max_tool_calls: null,
    store: false,
    background: false,
    service_tier: 'default',
    metadata: {},
    safety_identifier: null,
    prompt_cache_key: null,
  };
}

/** Build provider-normalized Responses API usage from every billed call. */
export function buildResponsesUsage(
  collectedUsage: ReadonlyArray<UsageMetadata | null | undefined>,
): Usage {
  const { total, primary, subagent } = aggregateCollectedUsage(collectedUsage);
  return {
    input_tokens: total.inputTokens,
    output_tokens: total.outputTokens,
    total_tokens: total.totalTokens,
    input_tokens_details: { cached_tokens: total.cacheReadTokens },
    output_tokens_details: { reasoning_tokens: total.reasoningTokens },
    primary: {
      input_tokens: primary.inputTokens,
      output_tokens: primary.outputTokens,
      total_tokens: primary.totalTokens,
    },
    subagent: {
      input_tokens: subagent.inputTokens,
      output_tokens: subagent.outputTokens,
      total_tokens: subagent.totalTokens,
    },
  };
}

/**
 * Create event handlers for non-streaming aggregation
 */
export function createAggregatorEventHandlers(aggregator: ResponseAggregator): Record<
  string,
  {
    handle: (event: string, data: unknown) => void;
  }
> {
  const activeToolCalls = new Set<string>();
  const chunkResolver = createToolCallChunkResolver();

  return {
    on_message_delta: {
      handle: (_event: string, data: unknown): void => {
        const deltaData = data as { delta?: { content?: Array<{ type: string; text?: string }> } };
        const content = deltaData?.delta?.content;

        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === 'text' && part.text) {
              aggregator.addText(part.text);
            }
          }
        }
      },
    },

    on_reasoning_delta: {
      handle: (_event: string, data: unknown): void => {
        const deltaData = data as {
          delta?: { content?: Array<{ type: string; text?: string; think?: string }> };
        };
        const content = deltaData?.delta?.content;

        if (Array.isArray(content)) {
          for (const part of content) {
            const text = part.think || part.text;
            if (text) {
              aggregator.addReasoning(text);
            }
          }
        }
      },
    },

    on_run_step: {
      handle: (_event: string, data: unknown): void => {
        const stepData = data as {
          id?: string;
          stepDetails?: {
            type: string;
            tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>;
          };
        };
        const stepDetails = stepData?.stepDetails;

        if (stepDetails?.type === 'tool_calls' && stepDetails.tool_calls) {
          const stepCallIds: string[] = [];
          for (const tc of stepDetails.tool_calls) {
            const callId = tc.id ?? '';
            const name = tc.name ?? '';

            if (!callId) {
              continue;
            }

            stepCallIds.push(callId);
            if (!activeToolCalls.has(callId)) {
              activeToolCalls.add(callId);
              // A provider that does not stream its arguments delivers them here instead.
              const seeded = typeof tc.args === 'string' ? tc.args : '';
              aggregator.toolCalls.set(callId, { id: callId, name, arguments: seeded });
            }
          }
          chunkResolver.registerStep(stepData?.id ?? '', stepCallIds);
        }
      },
    },

    on_run_step_delta: {
      handle: (_event: string, data: unknown): void => {
        const deltaData = data as {
          id?: string;
          delta?: { type: string; tool_calls?: ToolCallChunk[] };
        };
        const delta = deltaData?.delta;

        if (delta?.type === 'tool_calls' && delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            // Resolved before the empty-args check so an id-bearing opening chunk is recorded.
            const callId = chunkResolver.resolve(deltaData?.id ?? '', tc);
            const args = typeof tc.args === 'string' ? tc.args : '';
            if (!args || !callId) {
              continue;
            }

            const existing = aggregator.toolCalls.get(callId);
            if (existing) {
              existing.arguments += args;
            }
          }
        }
      },
    },

    on_tool_end: {
      handle: (_event: string, data: unknown): void => {
        const toolData = data as { tool_call_id?: string; output?: string };
        const callId = toolData?.tool_call_id;
        const output = toolData?.output ?? '';

        if (callId) {
          aggregator.toolOutputs.set(callId, output);
        }
      },
    },

    on_chat_model_end: {
      handle: (_event: string, data: unknown): void => {
        const endData = data as {
          output?: {
            usage_metadata?: ModelUsageMetadata;
          };
        };

        const usage = endData?.output?.usage_metadata;
        if (usage) {
          accumulateResponseUsage(aggregator.usage, usage);
        }

        for (const { id, args } of completedToolCallArguments(data)) {
          const existing = aggregator.toolCalls.get(id);
          if (existing && existing.arguments === '') {
            existing.arguments = args;
          }
        }
      },
    },
  };
}

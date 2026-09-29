/**
 * Open Responses API Handlers
 *
 * Semantic event emitters and response tracking for the Open Responses API.
 * Events follow the Open Responses spec with proper lifecycle management.
 */
import type { Response as ServerResponse } from 'express';
import type {
  Response,
  ResponseContext,
  ResponseEvent,
  OutputItem,
  MessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  ReasoningItem,
  OutputTextContent,
  ReasoningTextContent,
  ItemStatus,
  ResponseStatus,
  Usage,
} from './types';

/* =============================================================================
 * RESPONSE TRACKER
 * ============================================================================= */

/**
 * Tracks the state of a response during streaming.
 * Manages items, sequence numbers, and accumulated content.
 */
export interface ResponseTracker {
  /** Current sequence number (monotonically increasing) */
  sequenceNumber: number;
  /** Output items being built */
  items: OutputItem[];
  /** Current message item (if any) */
  currentMessage: MessageItem | null;
  /** Current message content index */
  currentContentIndex: number;
  /** Current reasoning item (if any) */
  currentReasoning: ReasoningItem | null;
  /** Current reasoning content index */
  currentReasoningContentIndex: number;
  /** Map of function call items by call_id */
  functionCalls: Map<string, FunctionCallItem>;
  /** Map of function call outputs by call_id */
  functionCallOutputs: Map<string, FunctionCallOutputItem>;
  /** Accumulated text for current message */
  accumulatedText: string;
  /** Accumulated reasoning text */
  accumulatedReasoningText: string;
  /** Accumulated function call arguments by call_id */
  accumulatedArguments: Map<string, string>;
  /** Token usage */
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedTokens: number;
  };
  /** Response status */
  status: ResponseStatus;
  /** Get next sequence number */
  nextSequence: () => number;
}

/**
 * Create a new response tracker
 */
export function createResponseTracker(): ResponseTracker {
  const tracker: ResponseTracker = {
    sequenceNumber: 0,
    items: [],
    currentMessage: null,
    currentContentIndex: 0,
    currentReasoning: null,
    currentReasoningContentIndex: 0,
    functionCalls: new Map(),
    functionCallOutputs: new Map(),
    accumulatedText: '',
    accumulatedReasoningText: '',
    accumulatedArguments: new Map(),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
    },
    status: 'in_progress',
    nextSequence: () => tracker.sequenceNumber++,
  };
  return tracker;
}

/* =============================================================================
 * SSE EVENT WRITING
 * ============================================================================= */

/**
 * Write a semantic SSE event to the response.
 * The `event:` field matches the `type` in the data payload.
 */
export function writeEvent(res: ServerResponse, event: ResponseEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Write the terminal [DONE] event
 */
export function writeDone(res: ServerResponse): void {
  res.write('data: [DONE]\n\n');
}

/* =============================================================================
 * RESPONSE BUILDING
 * ============================================================================= */

/**
 * Build a Response object from context and tracker
 * Includes all required fields per Open Responses spec
 */
export function buildResponse(
  context: ResponseContext,
  tracker: ResponseTracker,
  status: ResponseStatus = 'in_progress',
  usageOverride?: Usage,
): Response {
  const isCompleted = status === 'completed';

  return {
    // Required fields
    id: context.responseId,
    object: 'response',
    created_at: context.createdAt,
    completed_at: isCompleted ? Math.floor(Date.now() / 1000) : null,
    status,
    incomplete_details: null,
    model: context.model,
    previous_response_id: context.previousResponseId ?? null,
    instructions: context.instructions ?? null,
    output: tracker.items,
    error: null,
    tools: context.tools ?? [],
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
    usage: isCompleted
      ? (usageOverride ?? {
          input_tokens: tracker.usage.inputTokens,
          output_tokens: tracker.usage.outputTokens,
          total_tokens: tracker.usage.inputTokens + tracker.usage.outputTokens,
          input_tokens_details: { cached_tokens: tracker.usage.cachedTokens },
          output_tokens_details: { reasoning_tokens: tracker.usage.reasoningTokens },
        })
      : null,
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

/* =============================================================================
 * ITEM BUILDERS
 * ============================================================================= */

let itemIdCounter = 0;

/**
 * Generate a unique item ID
 */
export function generateItemId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${(itemIdCounter++).toString(36)}`;
}

/**
 * Create a new message item
 */
export function createMessageItem(status: ItemStatus = 'in_progress'): MessageItem {
  return {
    type: 'message',
    id: generateItemId('msg'),
    role: 'assistant',
    status,
    content: [],
  };
}

/**
 * Create a new function call item
 */
export function createFunctionCallItem(
  callId: string,
  name: string,
  status: ItemStatus = 'in_progress',
): FunctionCallItem {
  return {
    type: 'function_call',
    id: generateItemId('fc'),
    call_id: callId,
    name,
    arguments: '',
    status,
  };
}

/**
 * Create a new function call output item
 */
export function createFunctionCallOutputItem(
  callId: string,
  output: string,
  status: ItemStatus = 'completed',
): FunctionCallOutputItem {
  return {
    type: 'function_call_output',
    id: generateItemId('fco'),
    call_id: callId,
    output,
    status,
  };
}

/**
 * Create a new reasoning item
 */
export function createReasoningItem(status: ItemStatus = 'in_progress'): ReasoningItem {
  return {
    type: 'reasoning',
    id: generateItemId('reason'),
    status,
    content: [],
    summary: [],
  };
}

/**
 * Create output text content
 */
export function createOutputTextContent(text: string = ''): OutputTextContent {
  return {
    type: 'output_text',
    text,
    annotations: [],
    logprobs: [],
  };
}

/**
 * Create reasoning text content
 */
export function createReasoningTextContent(text: string = ''): ReasoningTextContent {
  return {
    type: 'reasoning_text',
    text,
  };
}

/* =============================================================================
 * STREAMING EVENT EMITTERS
 * ============================================================================= */

export interface StreamHandlerConfig {
  res: ServerResponse;
  context: ResponseContext;
  tracker: ResponseTracker;
  /**
   * Names the caller declared and executes itself. A call to one of these is
   * never run by the server, so `on_tool_end` cannot terminate its item and the
   * run's own finalization has to. Omitted by every request that declares none,
   * which leaves that request's event stream untouched.
   */
  clientToolNames?: ReadonlySet<string>;
}

/**
 * Emit response.created event
 * This is the first event emitted per the Open Responses spec
 */
export function emitResponseCreated(config: StreamHandlerConfig): void {
  const { res, context, tracker } = config;
  const response = buildResponse(context, tracker, 'in_progress');
  writeEvent(res, {
    type: 'response.created',
    sequence_number: tracker.nextSequence(),
    response,
  });
}

/**
 * Emit response.in_progress event
 */
export function emitResponseInProgress(config: StreamHandlerConfig): void {
  const { res, context, tracker } = config;
  const response = buildResponse(context, tracker, 'in_progress');
  writeEvent(res, {
    type: 'response.in_progress',
    sequence_number: tracker.nextSequence(),
    response,
  });
}

/**
 * Emit response.completed event
 */
export function emitResponseCompleted(config: StreamHandlerConfig, usage?: Usage): void {
  const { res, context, tracker } = config;
  tracker.status = 'completed';
  const response = buildResponse(context, tracker, 'completed', usage);
  writeEvent(res, {
    type: 'response.completed',
    sequence_number: tracker.nextSequence(),
    response,
  });
}

/**
 * Emit response.failed event
 */
export function emitResponseFailed(
  config: StreamHandlerConfig,
  error: { type: string; message: string; code?: string },
): void {
  const { res, context, tracker } = config;
  tracker.status = 'failed';
  const response = buildResponse(context, tracker, 'failed');
  response.error = {
    type: error.type as
      | 'server_error'
      | 'invalid_request'
      | 'not_found'
      | 'model_error'
      | 'too_many_requests',
    message: error.message,
    code: error.code,
  };
  writeEvent(res, {
    type: 'response.failed',
    sequence_number: tracker.nextSequence(),
    response,
  });
}

/**
 * Emit response.output_item.added event for a message
 */
export function emitMessageItemAdded(config: StreamHandlerConfig): MessageItem {
  const { res, tracker } = config;
  const item = createMessageItem('in_progress');
  tracker.currentMessage = item;
  tracker.currentContentIndex = 0;
  tracker.accumulatedText = '';
  tracker.items.push(item);

  writeEvent(res, {
    type: 'response.output_item.added',
    sequence_number: tracker.nextSequence(),
    output_index: tracker.items.length - 1,
    item,
  });

  return item;
}

/**
 * Emit response.output_item.done event for a message
 */
export function emitMessageItemDone(config: StreamHandlerConfig): void {
  const { res, tracker } = config;
  if (!tracker.currentMessage) {
    return;
  }

  tracker.currentMessage.status = 'completed';
  const outputIndex = tracker.items.indexOf(tracker.currentMessage);

  writeEvent(res, {
    type: 'response.output_item.done',
    sequence_number: tracker.nextSequence(),
    output_index: outputIndex,
    item: tracker.currentMessage,
  });

  tracker.currentMessage = null;
}

/**
 * Emit response.content_part.added for text content
 */
export function emitTextContentPartAdded(config: StreamHandlerConfig): void {
  const { res, tracker } = config;
  if (!tracker.currentMessage) {
    return;
  }

  const part = createOutputTextContent('');
  tracker.currentMessage.content.push(part);
  const outputIndex = tracker.items.indexOf(tracker.currentMessage);

  writeEvent(res, {
    type: 'response.content_part.added',
    sequence_number: tracker.nextSequence(),
    item_id: tracker.currentMessage.id,
    output_index: outputIndex,
    content_index: tracker.currentContentIndex,
    part,
  });
}

/**
 * Emit response.output_text.delta event
 */
export function emitOutputTextDelta(config: StreamHandlerConfig, delta: string): void {
  const { res, tracker } = config;
  if (!tracker.currentMessage) {
    return;
  }

  tracker.accumulatedText += delta;
  const outputIndex = tracker.items.indexOf(tracker.currentMessage);

  writeEvent(res, {
    type: 'response.output_text.delta',
    sequence_number: tracker.nextSequence(),
    item_id: tracker.currentMessage.id,
    output_index: outputIndex,
    content_index: tracker.currentContentIndex,
    delta,
    logprobs: [],
  });
}

/**
 * Emit response.output_text.done event
 */
export function emitOutputTextDone(config: StreamHandlerConfig): void {
  const { res, tracker } = config;
  if (!tracker.currentMessage) {
    return;
  }

  const outputIndex = tracker.items.indexOf(tracker.currentMessage);
  const contentIndex = tracker.currentContentIndex;

  // Update the content part with final text
  if (tracker.currentMessage.content[contentIndex]) {
    (tracker.currentMessage.content[contentIndex] as OutputTextContent).text =
      tracker.accumulatedText;
  }

  writeEvent(res, {
    type: 'response.output_text.done',
    sequence_number: tracker.nextSequence(),
    item_id: tracker.currentMessage.id,
    output_index: outputIndex,
    content_index: contentIndex,
    text: tracker.accumulatedText,
    logprobs: [],
  });
}

/**
 * Emit response.content_part.done for text content
 */
export function emitTextContentPartDone(config: StreamHandlerConfig): void {
  const { res, tracker } = config;
  if (!tracker.currentMessage) {
    return;
  }

  const outputIndex = tracker.items.indexOf(tracker.currentMessage);
  const contentIndex = tracker.currentContentIndex;
  const part = tracker.currentMessage.content[contentIndex];

  if (part) {
    writeEvent(res, {
      type: 'response.content_part.done',
      sequence_number: tracker.nextSequence(),
      item_id: tracker.currentMessage.id,
      output_index: outputIndex,
      content_index: contentIndex,
      part,
    });
  }

  tracker.currentContentIndex++;
}

/* =============================================================================
 * FUNCTION CALL EVENT EMITTERS
 * ============================================================================= */

/**
 * Emit response.output_item.added for a function call
 */
export function emitFunctionCallItemAdded(
  config: StreamHandlerConfig,
  callId: string,
  name: string,
): FunctionCallItem {
  const { res, tracker } = config;
  const item = createFunctionCallItem(callId, name, 'in_progress');
  tracker.functionCalls.set(callId, item);
  tracker.accumulatedArguments.set(callId, '');
  tracker.items.push(item);

  writeEvent(res, {
    type: 'response.output_item.added',
    sequence_number: tracker.nextSequence(),
    output_index: tracker.items.length - 1,
    item,
  });

  return item;
}

/**
 * Emit response.function_call_arguments.delta event
 */
export function emitFunctionCallArgumentsDelta(
  config: StreamHandlerConfig,
  callId: string,
  delta: string,
): void {
  const { res, tracker } = config;
  const item = tracker.functionCalls.get(callId);
  if (!item) {
    return;
  }

  const accumulated = (tracker.accumulatedArguments.get(callId) ?? '') + delta;
  tracker.accumulatedArguments.set(callId, accumulated);
  item.arguments = accumulated;

  const outputIndex = tracker.items.indexOf(item);

  writeEvent(res, {
    type: 'response.function_call_arguments.delta',
    sequence_number: tracker.nextSequence(),
    item_id: item.id,
    output_index: outputIndex,
    call_id: callId,
    delta,
  });
}

/**
 * Emit response.function_call_arguments.done event
 */
export function emitFunctionCallArgumentsDone(config: StreamHandlerConfig, callId: string): void {
  const { res, tracker } = config;
  const item = tracker.functionCalls.get(callId);
  if (!item) {
    return;
  }

  const outputIndex = tracker.items.indexOf(item);
  const args = tracker.accumulatedArguments.get(callId) ?? '';

  writeEvent(res, {
    type: 'response.function_call_arguments.done',
    sequence_number: tracker.nextSequence(),
    item_id: item.id,
    output_index: outputIndex,
    call_id: callId,
    arguments: args,
  });
}

/**
 * Emit response.output_item.done for a function call
 */
export function emitFunctionCallItemDone(config: StreamHandlerConfig, callId: string): void {
  const { res, tracker } = config;
  const item = tracker.functionCalls.get(callId);
  if (!item) {
    return;
  }

  item.status = 'completed';
  const outputIndex = tracker.items.indexOf(item);

  writeEvent(res, {
    type: 'response.output_item.done',
    sequence_number: tracker.nextSequence(),
    output_index: outputIndex,
    item,
  });
}

/**
 * Emit function call output item (internal tool result)
 */
export function emitFunctionCallOutputItem(
  config: StreamHandlerConfig,
  callId: string,
  output: string,
): void {
  const { res, tracker } = config;
  const item = createFunctionCallOutputItem(callId, output, 'completed');
  tracker.functionCallOutputs.set(callId, item);
  tracker.items.push(item);

  // Emit added
  writeEvent(res, {
    type: 'response.output_item.added',
    sequence_number: tracker.nextSequence(),
    output_index: tracker.items.length - 1,
    item,
  });

  // Immediately emit done since it's already complete
  writeEvent(res, {
    type: 'response.output_item.done',
    sequence_number: tracker.nextSequence(),
    output_index: tracker.items.length - 1,
    item,
  });
}

/* =============================================================================
 * REASONING EVENT EMITTERS
 * ============================================================================= */

/**
 * Emit response.output_item.added for reasoning
 */
export function emitReasoningItemAdded(config: StreamHandlerConfig): ReasoningItem {
  const { res, tracker } = config;
  const item = createReasoningItem('in_progress');
  tracker.currentReasoning = item;
  tracker.currentReasoningContentIndex = 0;
  tracker.accumulatedReasoningText = '';
  tracker.items.push(item);

  writeEvent(res, {
    type: 'response.output_item.added',
    sequence_number: tracker.nextSequence(),
    output_index: tracker.items.length - 1,
    item,
  });

  return item;
}

/**
 * Emit response.content_part.added for reasoning
 */
export function emitReasoningContentPartAdded(config: StreamHandlerConfig): void {
  const { res, tracker } = config;
  if (!tracker.currentReasoning) {
    return;
  }

  const part = createReasoningTextContent('');
  if (!tracker.currentReasoning.content) {
    tracker.currentReasoning.content = [];
  }
  tracker.currentReasoning.content.push(part);
  const outputIndex = tracker.items.indexOf(tracker.currentReasoning);

  writeEvent(res, {
    type: 'response.content_part.added',
    sequence_number: tracker.nextSequence(),
    item_id: tracker.currentReasoning.id,
    output_index: outputIndex,
    content_index: tracker.currentReasoningContentIndex,
    part,
  });
}

/**
 * Emit response.reasoning.delta event
 */
export function emitReasoningDelta(config: StreamHandlerConfig, delta: string): void {
  const { res, tracker } = config;
  if (!tracker.currentReasoning) {
    return;
  }

  tracker.accumulatedReasoningText += delta;
  const outputIndex = tracker.items.indexOf(tracker.currentReasoning);

  writeEvent(res, {
    type: 'response.reasoning.delta',
    sequence_number: tracker.nextSequence(),
    item_id: tracker.currentReasoning.id,
    output_index: outputIndex,
    content_index: tracker.currentReasoningContentIndex,
    delta,
  });
}

/**
 * Emit response.reasoning.done event
 */
export function emitReasoningDone(config: StreamHandlerConfig): void {
  const { res, tracker } = config;
  if (!tracker.currentReasoning || !tracker.currentReasoning.content) {
    return;
  }

  const outputIndex = tracker.items.indexOf(tracker.currentReasoning);
  const contentIndex = tracker.currentReasoningContentIndex;

  // Update the content part with final text
  if (tracker.currentReasoning.content[contentIndex]) {
    (tracker.currentReasoning.content[contentIndex] as ReasoningTextContent).text =
      tracker.accumulatedReasoningText;
  }

  writeEvent(res, {
    type: 'response.reasoning.done',
    sequence_number: tracker.nextSequence(),
    item_id: tracker.currentReasoning.id,
    output_index: outputIndex,
    content_index: contentIndex,
    text: tracker.accumulatedReasoningText,
  });
}

/**
 * Emit response.content_part.done for reasoning
 */
export function emitReasoningContentPartDone(config: StreamHandlerConfig): void {
  const { res, tracker } = config;
  if (!tracker.currentReasoning || !tracker.currentReasoning.content) {
    return;
  }

  const outputIndex = tracker.items.indexOf(tracker.currentReasoning);
  const contentIndex = tracker.currentReasoningContentIndex;
  const part = tracker.currentReasoning.content[contentIndex];

  if (part) {
    writeEvent(res, {
      type: 'response.content_part.done',
      sequence_number: tracker.nextSequence(),
      item_id: tracker.currentReasoning.id,
      output_index: outputIndex,
      content_index: contentIndex,
      part,
    });
  }

  tracker.currentReasoningContentIndex++;
}

/**
 * Emit response.output_item.done for reasoning
 */
export function emitReasoningItemDone(config: StreamHandlerConfig): void {
  const { res, tracker } = config;
  if (!tracker.currentReasoning) {
    return;
  }

  tracker.currentReasoning.status = 'completed';
  const outputIndex = tracker.items.indexOf(tracker.currentReasoning);

  writeEvent(res, {
    type: 'response.output_item.done',
    sequence_number: tracker.nextSequence(),
    output_index: outputIndex,
    item: tracker.currentReasoning,
  });

  tracker.currentReasoning = null;
}

/* =============================================================================
 * ERROR HANDLING
 * ============================================================================= */

/**
 * Emit error event
 */
export function emitError(
  config: StreamHandlerConfig,
  error: { type: string; message: string; code?: string },
): void {
  const { res, tracker } = config;

  writeEvent(res, {
    type: 'error',
    sequence_number: tracker.nextSequence(),
    error: {
      type: error.type as 'server_error',
      message: error.message,
      code: error.code,
    },
  });
}

/* =============================================================================
 * LIBRECHAT EXTENSION EVENTS
 * Custom events prefixed with 'librechat:' per Open Responses spec
 * @see https://openresponses.org/specification#extending-streaming-events
 * ============================================================================= */

/**
 * Attachment data for librechat:attachment events
 */
export interface AttachmentData {
  /** File ID in LibreChat storage */
  file_id?: string;
  /** Original filename */
  filename?: string;
  /** MIME type */
  type?: string;
  /** URL to access the file */
  url?: string;
  /** Base64-encoded image data (for inline images) */
  image_url?: string;
  /** Width for images */
  width?: number;
  /** Height for images */
  height?: number;
  /** Associated tool call ID */
  tool_call_id?: string;
  /**
   * Inline text or sanitized HTML preview (sized to MAX_TEXT_CACHE_BYTES).
   * Populated by `extractCodeArtifactText` for tool-output files: raw text
   * for plain-text artifacts, sanitized rich HTML for office formats
   * (DOCX/XLSX/CSV/PPTX). The frontend feeds HTML through the Sandpack
   * `static` template via `index.html`. Null if extraction was unavailable
   * (binary, oversized, or unsupported).
   */
  text?: string | null;
  /**
   * Format of the `text` field — `'html'` if `text` is a complete
   * sanitized HTML document the client is permitted to inject into the
   * iframe via `index.html`, `'text'` if it's plain text. Clients MUST
   * gate office-bucket routing on `textFormat === 'html'`; legacy
   * attachments and RAG-extracted plain text don't have this set and
   * must default to safe (markdown-escaped) rendering. Codex P1 review
   * on PR #12934.
   */
  textFormat?: 'html' | 'text' | null;
  /** Additional metadata */
  [key: string]: unknown;
}

/**
 * Emit librechat:attachment event for file/image attachments
 * This is a LibreChat extension to the Open Responses streaming protocol.
 * External clients can safely ignore these events.
 */
export function emitAttachment(
  config: StreamHandlerConfig,
  attachment: AttachmentData,
  options?: {
    messageId?: string;
    conversationId?: string;
  },
): void {
  const { res, tracker } = config;

  writeEvent(res, {
    type: 'librechat:attachment',
    sequence_number: tracker.nextSequence(),
    attachment,
    message_id: options?.messageId,
    conversation_id: options?.conversationId,
  });
}

/**
 * Write attachment event directly to response (for use outside streaming context)
 * Useful when attachment processing happens asynchronously
 */
export function writeAttachmentEvent(
  res: ServerResponse,
  sequenceNumber: number,
  attachment: AttachmentData,
  options?: {
    messageId?: string;
    conversationId?: string;
  },
): void {
  writeEvent(res, {
    type: 'librechat:attachment',
    sequence_number: sequenceNumber,
    attachment,
    message_id: options?.messageId,
    conversation_id: options?.conversationId,
  });
}

/* =============================================================================
 * NON-STREAMING RESPONSE BUILDER
 * ============================================================================= */

/**
 * Build a complete non-streaming response
 */
export function buildResponsesNonStreamingResponse(
  context: ResponseContext,
  tracker: ResponseTracker,
): Response {
  return buildResponse(context, tracker, 'completed');
}

/**
 * Update tracker usage from collected data
 */
export function updateTrackerUsage(
  tracker: ResponseTracker,
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
    cachedTokens?: number;
  },
): void {
  if (usage.promptTokens != null) {
    tracker.usage.inputTokens = usage.promptTokens;
  }
  if (usage.completionTokens != null) {
    tracker.usage.outputTokens = usage.completionTokens;
  }
  if (usage.reasoningTokens != null) {
    tracker.usage.reasoningTokens = usage.reasoningTokens;
  }
  if (usage.cachedTokens != null) {
    tracker.usage.cachedTokens = usage.cachedTokens;
  }
}

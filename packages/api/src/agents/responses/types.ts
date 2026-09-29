/**
 * Open Responses API Types
 *
 * Types following the Open Responses specification for building multi-provider,
 * interoperable LLM interfaces. Items are the fundamental unit of context,
 * and streaming uses semantic events rather than simple deltas.
 *
 * @see https://openresponses.org/specification
 */

/* =============================================================================
 * ENUMS
 * ============================================================================= */

/** Item status lifecycle */
export type ItemStatus = 'in_progress' | 'incomplete' | 'completed';

/** Response status lifecycle */
export type ResponseStatus = 'in_progress' | 'completed' | 'failed' | 'incomplete';

/** Message roles */
export type MessageRole = 'user' | 'assistant' | 'system' | 'developer';

/** Tool choice options */
export type ToolChoiceValue = 'none' | 'auto' | 'required';

/** Truncation options */
export type TruncationValue = 'auto' | 'disabled';

/** Service tier options */
export type ServiceTier = 'auto' | 'default' | 'flex' | 'priority';

/** Reasoning effort levels */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

/** Reasoning summary options */
export type ReasoningSummary = 'concise' | 'detailed' | 'auto';

/* =============================================================================
 * INPUT CONTENT TYPES
 * ============================================================================= */

/** Text input content */
export interface InputTextContent {
  type: 'input_text';
  text: string;
}

/** Image input content */
export interface InputImageContent {
  type: 'input_image';
  image_url?: string;
  file_id?: string;
  detail?: 'auto' | 'low' | 'high';
}

/** File input content */
export interface InputFileContent {
  type: 'input_file';
  file_id?: string;
  file_data?: string;
  filename?: string;
}

/** Union of all input content types */
export type InputContent = InputTextContent | InputImageContent | InputFileContent;

/* =============================================================================
 * OUTPUT CONTENT TYPES
 * ============================================================================= */

/** Log probability for a token */
export interface LogProb {
  token: string;
  logprob: number;
  bytes?: number[];
  top_logprobs?: TopLogProb[];
}

/** Top log probability entry */
export interface TopLogProb {
  token: string;
  logprob: number;
  bytes?: number[];
}

/** Text output content */
export interface OutputTextContent {
  type: 'output_text';
  text: string;
  annotations: Annotation[];
  logprobs: LogProb[];
}

/** Refusal content */
export interface RefusalContent {
  type: 'refusal';
  refusal: string;
}

/** Union of model output content types */
export type ModelContent = OutputTextContent | RefusalContent;

/* =============================================================================
 * ANNOTATIONS
 * ============================================================================= */

/** URL citation annotation */
export interface UrlCitationAnnotation {
  type: 'url_citation';
  url: string;
  title?: string;
  start_index: number;
  end_index: number;
}

/** File citation annotation */
export interface FileCitationAnnotation {
  type: 'file_citation';
  file_id: string;
  start_index: number;
  end_index: number;
}

/** Union of annotation types */
export type Annotation = UrlCitationAnnotation | FileCitationAnnotation;

/* =============================================================================
 * REASONING CONTENT
 * ============================================================================= */

/** Reasoning text content */
export interface ReasoningTextContent {
  type: 'reasoning_text';
  text: string;
}

/** Summary text content */
export interface SummaryTextContent {
  type: 'summary_text';
  text: string;
}

/** Reasoning content union */
export type ReasoningContent = ReasoningTextContent;

/* =============================================================================
 * INPUT ITEMS (for request)
 * ============================================================================= */

/** System message input item */
export interface SystemMessageItemParam {
  type: 'message';
  role: 'system';
  content: string | InputContent[];
}

/** Developer message input item */
export interface DeveloperMessageItemParam {
  type: 'message';
  role: 'developer';
  content: string | InputContent[];
}

/** User message input item */
export interface UserMessageItemParam {
  type: 'message';
  role: 'user';
  content: string | InputContent[];
}

/** Assistant message input item */
export interface AssistantMessageItemParam {
  type: 'message';
  role: 'assistant';
  content: string | ModelContent[];
}

/** Function call input item (for providing context) */
export interface FunctionCallItemParam {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: ItemStatus;
}

/** Function call output input item (for providing tool results) */
export interface FunctionCallOutputItemParam {
  type: 'function_call_output';
  call_id: string;
  output: string;
  status?: ItemStatus;
}

/** Reasoning input item */
export interface ReasoningItemParam {
  type: 'reasoning';
  id?: string;
  content?: ReasoningContent[];
  encrypted_content?: string;
  summary?: SummaryTextContent[];
  status?: ItemStatus;
}

/** Item reference (for referencing existing items) */
export interface ItemReferenceParam {
  type: 'item_reference';
  id: string;
}

/** Union of all input item types */
export type InputItem =
  | SystemMessageItemParam
  | DeveloperMessageItemParam
  | UserMessageItemParam
  | AssistantMessageItemParam
  | FunctionCallItemParam
  | FunctionCallOutputItemParam
  | ReasoningItemParam
  | ItemReferenceParam;

/* =============================================================================
 * OUTPUT ITEMS (in response)
 * ============================================================================= */

/** Message output item */
export interface MessageItem {
  type: 'message';
  id: string;
  role: 'assistant';
  status: ItemStatus;
  content: ModelContent[];
}

/** Function call output item */
export interface FunctionCallItem {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: ItemStatus;
}

/** Function call output result item (internal tool execution result) */
export interface FunctionCallOutputItem {
  type: 'function_call_output';
  id: string;
  call_id: string;
  output: string;
  status: ItemStatus;
}

/** Reasoning output item */
export interface ReasoningItem {
  type: 'reasoning';
  id: string;
  status?: ItemStatus;
  content?: ReasoningContent[];
  encrypted_content?: string;
  /** Required per Open Responses spec - summary content parts */
  summary: SummaryTextContent[];
}

/** Union of all output item types */
export type OutputItem = MessageItem | FunctionCallItem | FunctionCallOutputItem | ReasoningItem;

/* =============================================================================
 * TOOLS
 * ============================================================================= */

/** Function tool definition */
export interface FunctionTool {
  type: 'function';
  name: string;
  description?: string | null;
  parameters?: Record<string, unknown> | null;
  strict?: boolean;
}

/** Hosted tool (provider-specific) */
export interface HostedTool {
  type: string; // e.g., 'librechat:web_search'
  [key: string]: unknown;
}

/** Union of tool types */
export type Tool = FunctionTool | HostedTool;

/** Specific function tool choice */
export interface FunctionToolChoice {
  type: 'function';
  name: string;
}

/** Tool choice parameter */
export type ToolChoice = ToolChoiceValue | FunctionToolChoice;

/* =============================================================================
 * REQUEST
 * ============================================================================= */

/** Reasoning configuration */
export interface ReasoningConfig {
  effort?: ReasoningEffort;
  summary?: ReasoningSummary;
}

/** Text output configuration */
export interface TextConfig {
  format?: {
    type: 'text' | 'json_object' | 'json_schema';
    json_schema?: Record<string, unknown>;
  };
}

/** Stream options */
export interface StreamOptions {
  include_usage?: boolean;
}

/** Metadata (key-value pairs) */
export type Metadata = Record<string, string>;

/** Open Responses API Request */
export interface ResponseRequest {
  /** Immutable attached-environment choice (LibreChat extension). */
  code_environment_mode?: import('librechat-data-provider').CodeEnvironmentMode;
  /** Explicit registered workspaces for attached agents (LibreChat extension). */
  code_workspaces?: import('librechat-data-provider').CodeWorkspaceSelection[];
  /** Model/agent ID to use */
  model: string;

  /** Input context - string or array of items */
  input: string | InputItem[];

  /** Previous response ID for conversation continuation */
  previous_response_id?: string;

  /** Tools available to the model */
  tools?: Tool[];

  /** Tool choice configuration */
  tool_choice?: ToolChoice;

  /** Whether to stream the response */
  stream?: boolean;

  /** Stream options */
  stream_options?: StreamOptions;

  /** Additional instructions */
  instructions?: string;

  /** Maximum output tokens */
  max_output_tokens?: number;

  /** Maximum tool calls */
  max_tool_calls?: number;

  /** Sampling temperature */
  temperature?: number;

  /** Top-p sampling */
  top_p?: number;

  /** Presence penalty */
  presence_penalty?: number;

  /** Frequency penalty */
  frequency_penalty?: number;

  /** Reasoning configuration */
  reasoning?: ReasoningConfig;

  /** Text output configuration */
  text?: TextConfig;

  /** Truncation behavior */
  truncation?: TruncationValue;

  /** Service tier */
  service_tier?: ServiceTier;

  /** Whether to store the response */
  store?: boolean;

  /** Metadata */
  metadata?: Metadata;

  /** Whether model can call multiple tools in parallel */
  parallel_tool_calls?: boolean;

  /** User identifier for safety */
  user?: string;
}

/* =============================================================================
 * RESPONSE
 * ============================================================================= */

/** Token usage details */
export interface InputTokensDetails {
  cached_tokens: number;
}

/** Output tokens details */
export interface OutputTokensDetails {
  reasoning_tokens: number;
}

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/** Token usage statistics */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: InputTokensDetails;
  output_tokens_details: OutputTokensDetails;
  /** LibreChat extension for parent, handoff, and summarization model calls. */
  primary?: UsageTotals;
  /** LibreChat extension for isolated subagent child model calls. */
  subagent?: UsageTotals;
}

/** Incomplete details */
export interface IncompleteDetails {
  reason: 'max_output_tokens' | 'max_tool_calls' | 'content_filter' | 'other';
}

/** Error object */
export interface ResponseError {
  type: 'server_error' | 'invalid_request' | 'not_found' | 'model_error' | 'too_many_requests';
  code?: string;
  message: string;
  param?: string;
}

/** Text field configuration */
export interface TextField {
  format?: {
    type: 'text' | 'json_object' | 'json_schema';
    json_schema?: Record<string, unknown>;
  };
}

/** Open Responses API Response - All required fields per spec */
export interface Response {
  /** Response ID */
  id: string;

  /** Object type - always "response" */
  object: 'response';

  /** Creation timestamp (Unix seconds) */
  created_at: number;

  /** Completion timestamp (Unix seconds) - null if not completed */
  completed_at: number | null;

  /** Response status */
  status: ResponseStatus;

  /** Incomplete details - null if not incomplete */
  incomplete_details: IncompleteDetails | null;

  /** Model that generated the response */
  model: string;

  /** Previous response ID - null if not a continuation */
  previous_response_id: string | null;

  /** Instructions used - null if none */
  instructions: string | null;

  /** Output items */
  output: OutputItem[];

  /** Error - null if no error */
  error: ResponseError | null;

  /** Tools available */
  tools: Tool[];

  /** Tool choice setting */
  tool_choice: ToolChoice;

  /** Truncation setting used */
  truncation: TruncationValue;

  /** Whether parallel tool calls were allowed */
  parallel_tool_calls: boolean;

  /** Text configuration used */
  text: TextField;

  /** Temperature used */
  temperature: number;

  /** Top-p used */
  top_p: number;

  /** Presence penalty used */
  presence_penalty: number;

  /** Frequency penalty used */
  frequency_penalty: number;

  /** Top logprobs - number of most likely tokens to return */
  top_logprobs: number;

  /** Reasoning configuration - null if none */
  reasoning: ReasoningConfig | null;

  /** User identifier - null if none */
  user: string | null;

  /** Token usage - null if not available */
  usage: Usage | null;

  /** Max output tokens - null if not set */
  max_output_tokens: number | null;

  /** Max tool calls - null if not set */
  max_tool_calls: number | null;

  /** Whether response was stored */
  store: boolean;

  /** Whether request was run in background */
  background: boolean;

  /** Service tier used */
  service_tier: string;

  /** Metadata */
  metadata: Metadata;

  /** Safety identifier - null if none */
  safety_identifier: string | null;

  /** Prompt cache key - null if none */
  prompt_cache_key: string | null;
}

/* =============================================================================
 * STREAMING EVENTS
 * ============================================================================= */

/** Base event structure */
export interface BaseEvent {
  type: string;
  sequence_number: number;
}

/** Response created event (first event in stream) */
export interface ResponseCreatedEvent extends BaseEvent {
  type: 'response.created';
  response: Response;
}

/** Response in_progress event */
export interface ResponseInProgressEvent extends BaseEvent {
  type: 'response.in_progress';
  response: Response;
}

/** Response completed event */
export interface ResponseCompletedEvent extends BaseEvent {
  type: 'response.completed';
  response: Response;
}

/** Response failed event */
export interface ResponseFailedEvent extends BaseEvent {
  type: 'response.failed';
  response: Response;
}

/** Response incomplete event */
export interface ResponseIncompleteEvent extends BaseEvent {
  type: 'response.incomplete';
  response: Response;
}

/** Output item added event */
export interface OutputItemAddedEvent extends BaseEvent {
  type: 'response.output_item.added';
  output_index: number;
  item: OutputItem;
}

/** Output item done event */
export interface OutputItemDoneEvent extends BaseEvent {
  type: 'response.output_item.done';
  output_index: number;
  item: OutputItem;
}

/** Content part added event */
export interface ContentPartAddedEvent extends BaseEvent {
  type: 'response.content_part.added';
  item_id: string;
  output_index: number;
  content_index: number;
  part: ModelContent | ReasoningContent;
}

/** Content part done event */
export interface ContentPartDoneEvent extends BaseEvent {
  type: 'response.content_part.done';
  item_id: string;
  output_index: number;
  content_index: number;
  part: ModelContent | ReasoningContent;
}

/** Output text delta event */
export interface OutputTextDeltaEvent extends BaseEvent {
  type: 'response.output_text.delta';
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
  logprobs: LogProb[];
}

/** Output text done event */
export interface OutputTextDoneEvent extends BaseEvent {
  type: 'response.output_text.done';
  item_id: string;
  output_index: number;
  content_index: number;
  text: string;
  logprobs: LogProb[];
}

/** Refusal delta event */
export interface RefusalDeltaEvent extends BaseEvent {
  type: 'response.refusal.delta';
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

/** Refusal done event */
export interface RefusalDoneEvent extends BaseEvent {
  type: 'response.refusal.done';
  item_id: string;
  output_index: number;
  content_index: number;
  refusal: string;
}

/** Function call arguments delta event */
export interface FunctionCallArgumentsDeltaEvent extends BaseEvent {
  type: 'response.function_call_arguments.delta';
  item_id: string;
  output_index: number;
  call_id: string;
  delta: string;
}

/** Function call arguments done event */
export interface FunctionCallArgumentsDoneEvent extends BaseEvent {
  type: 'response.function_call_arguments.done';
  item_id: string;
  output_index: number;
  call_id: string;
  arguments: string;
}

/** Reasoning delta event */
export interface ReasoningDeltaEvent extends BaseEvent {
  type: 'response.reasoning.delta';
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

/** Reasoning done event */
export interface ReasoningDoneEvent extends BaseEvent {
  type: 'response.reasoning.done';
  item_id: string;
  output_index: number;
  content_index: number;
  text: string;
}

/** Error event */
export interface ErrorEvent extends BaseEvent {
  type: 'error';
  error: ResponseError;
}

/* =============================================================================
 * LIBRECHAT EXTENSION TYPES
 * Per Open Responses spec, custom types MUST be prefixed with implementor slug
 * @see https://openresponses.org/specification#extending-streaming-events
 * ============================================================================= */

/** Attachment content types for LibreChat extensions */
export interface LibreChatAttachmentContent {
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
  /** Additional metadata */
  [key: string]: unknown;
}

/**
 * LibreChat attachment event - custom streaming event for file/image attachments
 * Follows Open Responses extension pattern with librechat: prefix
 */
export interface LibreChatAttachmentEvent extends BaseEvent {
  type: 'librechat:attachment';
  /** The attachment data */
  attachment: LibreChatAttachmentContent;
  /** Associated message ID */
  message_id?: string;
  /** Associated conversation ID */
  conversation_id?: string;
}

/** Union of all streaming events (including LibreChat extensions) */
export type ResponseEvent =
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent
  | ResponseIncompleteEvent
  | OutputItemAddedEvent
  | OutputItemDoneEvent
  | ContentPartAddedEvent
  | ContentPartDoneEvent
  | OutputTextDeltaEvent
  | OutputTextDoneEvent
  | RefusalDeltaEvent
  | RefusalDoneEvent
  | FunctionCallArgumentsDeltaEvent
  | FunctionCallArgumentsDoneEvent
  | ReasoningDeltaEvent
  | ReasoningDoneEvent
  | ErrorEvent
  // LibreChat extensions (prefixed per Open Responses spec)
  | LibreChatAttachmentEvent;

/* =============================================================================
 * INTERNAL TYPES
 * ============================================================================= */

/** Context for building responses */
export interface ResponseContext {
  /** Response ID */
  responseId: string;
  /** Model/agent ID */
  model: string;
  /** Creation timestamp */
  createdAt: number;
  /** Previous response ID */
  previousResponseId?: string;
  /** Instructions */
  instructions?: string;
  /**
   * The caller's function tools that were actually declared to the model,
   * echoed back on the response. Absent until the run resolves them.
   */
  tools?: FunctionTool[];
}

/** Validation result for requests */
export interface RequestValidationResult {
  valid: boolean;
  request?: ResponseRequest;
  error?: string;
}

/**
 * OpenAI-compatible types for the agent chat completions API.
 * These types follow the OpenAI API spec for /v1/chat/completions.
 *
 * Note: This API uses agent_id as the "model" parameter per OpenAI spec.
 * In the future, this will be extended to support the Responses API.
 */

/**
 * Content part types for OpenAI format
 */
export interface OpenAITextContentPart {
  type: 'text';
  text: string;
}

export interface OpenAIImageContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export type OpenAIContentPart = OpenAITextContentPart | OpenAIImageContentPart;

/**
 * Tool call in OpenAI format
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * OpenAI chat message format
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/**
 * OpenAI chat completion request
 */
export interface ChatCompletionRequest {
  /** Agent ID to invoke (maps to model in OpenAI spec) */
  model: string;
  /** Conversation messages */
  messages: ChatMessage[];
  /** Whether to stream the response */
  stream?: boolean;
  /** Maximum tokens to generate */
  max_tokens?: number;
  /** Temperature for sampling */
  temperature?: number;
  /** Top-p sampling */
  top_p?: number;
  /** Frequency penalty */
  frequency_penalty?: number;
  /** Presence penalty */
  presence_penalty?: number;
  /** Stop sequences */
  stop?: string | string[];
  /** User identifier */
  user?: string;
  /** Conversation ID (LibreChat extension) */
  conversation_id?: string;
  /** Parent message ID (LibreChat extension) */
  parent_message_id?: string;
}

/**
 * Token usage information
 */
export interface CompletionUsageTotals {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Detailed breakdown of output tokens (OpenRouter/OpenAI convention) */
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  /** LibreChat extension for parent, handoff, and summarization model calls. */
  primary?: CompletionUsageTotals;
  /** LibreChat extension for isolated subagent child model calls. */
  subagent?: CompletionUsageTotals;
}

/**
 * Non-streaming choice
 */
export interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    /** Reasoning/thinking content (OpenRouter convention) */
    reasoning?: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

/**
 * Non-streaming response
 */
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: CompletionUsage;
}

/**
 * Streaming choice delta
 * Note: `reasoning` field follows OpenRouter convention for streaming reasoning/thinking content
 */
export interface ChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: 'assistant';
    content?: string | null;
    /** Reasoning/thinking content (OpenRouter convention) */
    reasoning?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: 'function';
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

/**
 * Streaming response chunk
 */
export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  /** Final chunk may include usage */
  usage?: CompletionUsage;
}

/**
 * SSE event wrapper for streaming
 */
export interface SSEEvent {
  data: ChatCompletionChunk | '[DONE]';
}

/**
 * Context for building OpenAI responses
 */
export interface OpenAIResponseContext {
  /** Request ID for the chat completion */
  requestId: string;
  /** Model/agent ID */
  model: string;
  /** Created timestamp */
  created: number;
}

/**
 * Aggregated content for building final response
 */
export interface AggregatedContent {
  text: string;
  toolCalls: ToolCall[];
}

/**
 * Error response in OpenAI format
 */
export interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

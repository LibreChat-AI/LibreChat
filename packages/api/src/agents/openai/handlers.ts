/**
 * OpenAI-compatible event handlers for agent streaming.
 *
 * These handlers convert LibreChat's internal graph events into OpenAI-compatible
 * streaming format (SSE with chat.completion.chunk objects).
 */
import { createOpenAIToolCallStream as createAcceptedToolCallStream } from '@librechat/agents/openai';
import type { Agents } from 'librechat-data-provider';
import type { Graph } from '@librechat/agents';
import type {
  ChatCompletionChunkChoice,
  OpenAIResponseContext,
  ChatCompletionChunk,
  CompletionUsage,
  ToolCall,
} from './types';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { ToolExecuteOptions } from '~/agents/handlers';
import { createToolExecuteHandler } from '~/agents/handlers';
import { aggregateCollectedUsage } from '../usage';

/**
 * Create a chat completion chunk in OpenAI format
 */
export function createChunk(
  context: OpenAIResponseContext,
  delta: ChatCompletionChunkChoice['delta'],
  finishReason: ChatCompletionChunkChoice['finish_reason'] = null,
  usage?: CompletionUsage,
): ChatCompletionChunk {
  return {
    id: context.requestId,
    object: 'chat.completion.chunk',
    created: context.created,
    model: context.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
    ...(usage && { usage }),
  };
}

/** One synchronous output frame; HTTP connection and lifecycle stay with the caller. */
export interface OpenAIWriter {
  write(frame: string): boolean | void;
}

/** Write one Chat Completions frame through a caller-owned transport. */
export function writeSSE(writer: OpenAIWriter, data: ChatCompletionChunk | string): void {
  writer.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

/**
 * Lightweight tracker for streaming responses.
 * Only tracks what's needed for finish_reason and usage - doesn't store content.
 */
export interface OpenAIStreamTracker {
  /** Successful response completion, installed by the response handlers. */
  finishToolCalls?: () => void;
  abortToolCalls?: () => void;
  /** Whether any text content was emitted */
  hasText: boolean;
  /** Whether any reasoning content was emitted */
  hasReasoning: boolean;
  /** Accumulated tool calls by index */
  toolCalls: Map<number, ToolCall>;
  /** Accumulated usage metadata */
  usage: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
  };
  /** Mark that text was emitted */
  addText: () => void;
  /** Mark that reasoning was emitted */
  addReasoning: () => void;
}

/**
 * Create a lightweight stream tracker (doesn't store content)
 */
export function createOpenAIStreamTracker(): OpenAIStreamTracker {
  const tracker: OpenAIStreamTracker = {
    hasText: false,
    hasReasoning: false,
    toolCalls: new Map(),
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
    },
    addText: () => {
      tracker.hasText = true;
    },
    addReasoning: () => {
      tracker.hasReasoning = true;
    },
  };
  return tracker;
}

/**
 * Content aggregator for non-streaming responses.
 * Accumulates full text content, reasoning, and tool calls.
 * Uses arrays for O(n) text accumulation instead of O(n²) string concatenation.
 */
export interface OpenAIContentAggregator {
  /** Successful response completion, installed by the response handlers. */
  finishToolCalls?: () => void;
  abortToolCalls?: () => void;
  /** Accumulated text chunks */
  textChunks: string[];
  /** Accumulated reasoning/thinking chunks */
  reasoningChunks: string[];
  /** Accumulated tool calls by index */
  toolCalls: Map<number, ToolCall>;
  /** Accumulated usage metadata */
  usage: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
  };
  /** Get accumulated text (joins chunks) */
  getText: () => string;
  /** Get accumulated reasoning (joins chunks) */
  getReasoning: () => string;
  /** Add text chunk */
  addText: (text: string) => void;
  /** Add reasoning chunk */
  addReasoning: (text: string) => void;
}

/**
 * Create a content aggregator for non-streaming responses
 */
export function createOpenAIContentAggregator(): OpenAIContentAggregator {
  const textChunks: string[] = [];
  const reasoningChunks: string[] = [];

  return {
    textChunks,
    reasoningChunks,
    toolCalls: new Map(),
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
    },
    getText: () => textChunks.join(''),
    getReasoning: () => reasoningChunks.join(''),
    addText: (text: string) => textChunks.push(text),
    addReasoning: (text: string) => reasoningChunks.push(text),
  };
}

/** Legacy stream configuration; retained for existing package consumers. */
export interface OpenAIStreamHandlerConfig {
  signal?: AbortSignal;
  res: OpenAIWriter;
  context: OpenAIResponseContext;
  tracker: OpenAIStreamTracker;
}

/** Transport-neutral stream configuration for new callers. */
export type OpenAIStreamWriterConfig = Omit<OpenAIStreamHandlerConfig, 'res'> & {
  writer: OpenAIWriter;
  res?: never;
};

type OpenAIContentStreamConfig = OpenAIStreamHandlerConfig | OpenAIStreamWriterConfig;

function getStreamWriter(config: OpenAIContentStreamConfig): OpenAIWriter {
  return 'writer' in config ? config.writer : config.res;
}

/**
 * Graph event types from @librechat/agents
 */
export const GraphEvents = {
  CHAT_MODEL_END: 'on_chat_model_end',
  TOOL_END: 'on_tool_end',
  CHAT_MODEL_STREAM: 'on_chat_model_stream',
  ON_RUN_STEP: 'on_run_step',
  ON_RUN_STEP_DELTA: 'on_run_step_delta',
  ON_RUN_STEP_COMPLETED: 'on_run_step_completed',
  ON_MESSAGE_DELTA: 'on_message_delta',
  ON_REASONING_DELTA: 'on_reasoning_delta',
  ON_TOOL_EXECUTE: 'on_tool_execute',
  ON_MODEL_RESPONSE: 'on_model_response',
  ON_MODEL_TOOLS_CLAIMED: 'on_model_tools_claimed',
} as const;

/**
 * Step types from librechat-data-provider
 */
export const StepTypes = {
  MESSAGE_CREATION: 'message_creation',
  TOOL_CALLS: 'tool_calls',
} as const;

/**
 * Event data interfaces
 */
export interface MessageDeltaData {
  id?: string;
  content?: Array<{ type: string; text?: string; think?: string }>;
  delta?: { content?: MessageDeltaData['content'] };
}

/**
 * One tool-call fragment of a run step delta, as `@librechat/agents` emits it:
 * `id`, `name`, and `args` can all be substrings. `index` identifies their
 * provider stream within the current model invocation. Reuse the shared chunk
 * contract and accept equivalent function-shaped name/argument fragments.
 */
export type RunStepToolCallChunk = Agents.ToolCallChunk & {
  function?: { name?: string; arguments?: string };
};

export interface RunStepDeltaData {
  /** The run step these fragments belong to. */
  id?: string;
  delta?: {
    type?: string;
    tool_calls?: RunStepToolCallChunk[];
  };
}

/** A tool call as the run step that opened it declares it. */
export type RunStepToolCall = Partial<Pick<Agents.ToolCall, 'id' | 'name' | 'args'>> & {
  index?: number;
  type?: string;
  function?: Partial<Agents.AgentFunctionToolCall['function']>;
};

export interface RunStepData {
  /** The run step's own id, shared with every delta dispatched for it. */
  id?: string;
  /** The step's position in the response content, not a tool-call index. */
  index?: number;
  stepDetails?: {
    type?: string;
    tool_calls?: RunStepToolCall[];
  };
}

export interface ToolEndData {
  output?: {
    name?: string;
    tool_call_id?: string;
    content?: string;
  };
}

export interface ModelEndData {
  output?: {
    usage_metadata?: {
      input_tokens?: number;
      output_tokens?: number;
      model?: string;
      output_token_details?: {
        reasoning?: number;
        reasoning_tokens?: number;
      };
    };
  };
}

/**
 * Event handler interface
 */
export interface EventHandler {
  handle(
    event: string,
    data: unknown,
    metadata?: Record<string, unknown>,
    graph?: unknown,
  ): void | Promise<void>;
}

/**
 * Projects the graph's tool-call events onto the OpenAI wire format.
 *
 * A client accumulates `delta.tool_calls` by `index`: the first chunk at an
 * index declares the call and must carry `id` and `function.name`, and every
 * later chunk at that index belongs to that same call. Neither index the graph
 * reports can serve as that key. A run step's `index` is its position in the
 * response's content, so a tool call that follows text does not start at zero,
 * and consecutive steps each carry a single-element `tool_calls` array rather
 * than one array holding every call. A fragment's `index` is the provider's
 * content-block index, which restarts at zero on each model invocation of the
 * run, so two different calls can share it.
 *
 * Outward indexes identify calls within declaring steps, using declaration slots
 * when IDs are absent. Provider indexes correlate raw fragments within an
 * invocation. IDs and names are assembled before publication: a client can freeze
 * both on its first chunk, and the graph provides no per-field completion seal.
 */
export interface OpenAIToolCallStreamConfig {
  /** Completed tool calls, populated at successful finish and keyed by outward index. */
  toolCalls: Map<number, ToolCall>;
  /** Emits complete identity/argument chunks at finish. Omitted for non-streaming. */
  emit?: (delta: ChatCompletionChunkChoice['delta']) => void;
  signal?: AbortSignal;
}

export interface OpenAIToolCallStream {
  /** Declares the tool calls a run step opened. */
  onRunStep: (data: RunStepData, metadata?: Record<string, unknown>, graph?: ToolCallGraph) => void;
  /** Accumulates the name and argument fragments streamed for a run step. */
  onRunStepDelta: (
    data: RunStepDeltaData,
    metadata?: Record<string, unknown>,
    graph?: ToolCallGraph,
  ) => void;
  /** Publish assembled, validated calls once after success, before DONE/JSON. */
  finish: () => void;
  /** Discard pending calls on failure and reject further writes. */
  abort: () => void;
}

type ToolCallGraph = Pick<Graph, 'getStepBaseKey'>;

interface ProjectedToolCall {
  index: number;
  snapshotId?: string;
  snapshotName?: string;
  snapshotArgs?: string;
  idFragments: string[];
  nameFragments: string[];
  argFragments: string[];
}

interface ToolCallStep {
  byId: Map<string, ProjectedToolCall>;
  byDeclaration: Map<string, ProjectedToolCall>;
  byProviderIndex: Map<number, ProjectedToolCall>;
  /** Declaration position is a fallback, never stronger than a provider binding. */
  byPosition: Map<number, ProjectedToolCall>;
  calls: Set<ProjectedToolCall>;
}

export function createOpenAIToolCallStream(
  config: OpenAIToolCallStreamConfig,
): OpenAIToolCallStream {
  const { toolCalls, emit, signal } = config;
  let phase: 'open' | 'finished' | 'aborted' = 'open';
  let unattributableArguments = false;
  const calls: ProjectedToolCall[] = [];
  const steps = new Map<string, ToolCallStep>();
  const invocations = new Map<string, Map<number, ProjectedToolCall>>();
  const stepScopes = new Map<string, string>();

  /** The SDK can send earlier parallel calls under the latest step ID. Its
   * invocation key owns segment/checkpoint transitions; cache it at declaration
   * so late events never borrow a new segment. Step isolation is the fallback. */
  const getBindings = (
    stepId: string,
    metadata?: Record<string, unknown>,
    graph?: ToolCallGraph,
  ): Map<number, ProjectedToolCall> => {
    let scope = stepScopes.get(stepId);
    if (scope === undefined) {
      if (graph && metadata) {
        scope = graph.getStepBaseKey(metadata);
      } else if (
        typeof metadata?.langgraph_node === 'string' &&
        typeof metadata.langgraph_step === 'number'
      ) {
        scope = JSON.stringify([
          metadata.run_id ?? '',
          metadata.thread_id ?? '',
          metadata.langgraph_node,
          metadata.langgraph_step,
          metadata.langgraph_checkpoint_ns ?? metadata.checkpoint_ns ?? '',
        ]);
      } else {
        scope = JSON.stringify(['step', stepId]);
      }
      stepScopes.set(stepId, scope);
    }
    let bindings = invocations.get(scope);
    if (bindings === undefined) {
      bindings = new Map();
      invocations.set(scope, bindings);
    }
    return bindings;
  };

  const getStep = (stepId: string): ToolCallStep => {
    let step = steps.get(stepId);
    if (step === undefined) {
      step = {
        byId: new Map(),
        byDeclaration: new Map(),
        byProviderIndex: new Map(),
        byPosition: new Map(),
        calls: new Set(),
      };
      steps.set(stepId, step);
    }
    return step;
  };

  const allocate = (step: ToolCallStep): ProjectedToolCall => {
    const call: ProjectedToolCall = {
      index: calls.length,
      idFragments: [],
      nameFragments: [],
      argFragments: [],
    };
    calls.push(call);
    step.calls.add(call);
    return call;
  };

  const abort = (): void => {
    if (phase !== 'finished') {
      phase = 'aborted';
    }
    calls.length = 0;
    steps.clear();
    stepScopes.clear();
    invocations.clear();
  };

  const writable = (): boolean => {
    if (signal?.aborted) {
      abort();
    }
    return phase === 'open';
  };

  return {
    abort,
    finish: () => {
      if (phase === 'finished') {
        return;
      }
      if (!writable()) {
        const error = new Error('Agent response aborted');
        error.name = 'AbortError';
        throw error;
      }
      try {
        if (unattributableArguments) {
          throw new Error('Unattributable tool call arguments in agent response');
        }
        const ready: ToolCall[] = [];
        const ids = new Set<string>();
        /** There is no per-field name/ID seal in the graph event contract. An
         * OpenAI-compatible client freezes the name on the first outward chunk.
         * Validate and assemble every call before publishing any: text still
         * streams, but tool chunks wait for successful response completion. */
        for (const call of calls) {
          const name = call.nameFragments.join('') || call.snapshotName;
          const args = call.argFragments.length ? call.argFragments.join('') : call.snapshotArgs;
          if (!name || args === undefined || args === '') {
            throw new Error('Incomplete tool call in agent response');
          }
          try {
            JSON.parse(args);
          } catch {
            throw new Error('Invalid tool call arguments in agent response');
          }
          let id = call.idFragments.join('') || call.snapshotId || `call_${call.index}`;
          while (ids.has(id)) {
            id = `${id}_${call.index}`;
          }
          ids.add(id);
          ready.push({ id, type: 'function', function: { name, arguments: args } });
        }
        for (const [index, call] of ready.entries()) {
          toolCalls.set(index, call);
        }
        /** Seal before invoking transport callbacks, including reentrant callers.
         * An emission failure cannot be retried into duplicate tool requests. */
        phase = 'finished';
        for (const [index, call] of ready.entries()) {
          emit?.({
            tool_calls: [
              {
                index,
                id: call.id,
                type: 'function',
                function: { name: call.function.name, arguments: '' },
              },
            ],
          });
          emit?.({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] });
        }
      } finally {
        abort();
      }
    },
    onRunStep: (data, metadata, graph) => {
      if (!writable()) {
        return;
      }
      const details = data?.stepDetails;
      if (details?.type !== StepTypes.TOOL_CALLS || !Array.isArray(details.tool_calls)) {
        return;
      }
      const step = getStep(data.id ?? '');
      const bindings = getBindings(data.id ?? '', metadata, graph);
      for (const [position, toolCall] of details.tool_calls.entries()) {
        const key =
          toolCall.index === undefined ? `position:${position}` : `index:${toolCall.index}`;
        let call =
          (toolCall.id ? step.byId.get(toolCall.id) : undefined) ?? step.byDeclaration.get(key);
        if (call === undefined && toolCall.index !== undefined) {
          call = step.byProviderIndex.get(toolCall.index);
        }
        /** A declaration can follow its raw chunks. Positions are meaningful
         * only inside this declaring step, never across the whole response. */
        if (call === undefined) {
          call = step.byProviderIndex.get(position);
          if (
            call === undefined &&
            step.byDeclaration.size === 0 &&
            details.tool_calls.length === 1 &&
            step.calls.size === 1
          ) {
            call = step.calls.values().next().value;
          }
        }
        call ??= allocate(step);
        step.byDeclaration.set(key, call);
        if (toolCall.id) {
          call.snapshotId = toolCall.id;
          step.byId.set(toolCall.id, call);
        }
        call.snapshotName = toolCall.name ?? toolCall.function?.name ?? call.snapshotName;
        const args = toolCall.function?.arguments ?? toolCall.args;
        if (args !== undefined) {
          /** Both public snapshot fields accept raw JSON strings or objects. */
          try {
            call.snapshotArgs = typeof args === 'string' ? args : JSON.stringify(args);
          } catch {
            throw new Error('Invalid tool call arguments in agent response');
          }
        }
        if (toolCall.index !== undefined) {
          step.byProviderIndex.set(toolCall.index, call);
          bindings.set(toolCall.index, call);
        } else if (details.tool_calls.length > 1) {
          step.byPosition.set(position, call);
        }
      }
    },
    onRunStepDelta: (data, metadata, graph) => {
      if (!writable()) {
        return;
      }
      const delta = data?.delta;
      if (delta?.type !== StepTypes.TOOL_CALLS || !Array.isArray(delta.tool_calls)) {
        return;
      }
      const step = getStep(data.id ?? '');
      const bindings = getBindings(data.id ?? '', metadata, graph);
      for (const fragment of delta.tool_calls) {
        const name = fragment.name ?? fragment.function?.name ?? '';
        const args = fragment.args ?? fragment.function?.arguments ?? '';
        /** An index identifies an already-bound raw stream even if this event
         * carries only a substring of its ID. Never key identity by that suffix. */
        let call = fragment.index === undefined ? undefined : bindings.get(fragment.index);
        call ??= fragment.id ? step.byId.get(fragment.id) : undefined;
        call ??= fragment.index === undefined ? undefined : step.byPosition.get(fragment.index);
        if (
          call === undefined &&
          step.calls.size === 1 &&
          (fragment.index === undefined || step.byProviderIndex.size === 0)
        ) {
          const singleton = step.calls.values().next().value;
          /** Without an index, a different full ID starts another raw call, not
           * another substring of the old call. Split IDs need their index. */
          if (
            !fragment.id ||
            fragment.index !== undefined ||
            (singleton?.snapshotId === undefined && singleton?.idFragments.length === 0)
          ) {
            call = singleton;
          }
        }
        if (call === undefined && (fragment.id || name)) {
          call = allocate(step);
        }
        if (call === undefined) {
          unattributableArguments ||= !!args;
          continue;
        }
        if (fragment.index !== undefined) {
          step.byProviderIndex.set(fragment.index, call);
          bindings.set(fragment.index, call);
        }
        if (fragment.id) {
          call.idFragments.push(fragment.id);
          /** Partial IDs are not aliases across indexed calls: two parallel
           * calls can both begin with `call_`. Their index is authoritative. */
          if (fragment.index === undefined) {
            step.byId.set(call.idFragments.join(''), call);
          }
        }
        if (name) {
          call.nameFragments.push(name);
        }
        if (args) {
          call.argFragments.push(args);
        }
      }
    },
  };
}

/** Success publishes validated calls; failure/abort never does. Both hosts
 * use this boundary so late provider events cannot mutate a settled response. */
export async function completeOpenAIToolCalls(
  lifecycle: Pick<OpenAIToolCallStream, 'finish' | 'abort'>,
  execute: () => Promise<void>,
): Promise<void> {
  try {
    await execute();
    lifecycle.finish();
  } finally {
    lifecycle.abort();
  }
}

/**
 * Handler for message delta events - streams text content
 */
export class OpenAIMessageDeltaHandler implements EventHandler {
  constructor(private config: OpenAIContentHandlerConfig) {}

  handle(_event: string, data: MessageDeltaData): void {
    const content = data?.delta?.content ?? data?.content;
    if (!content || !Array.isArray(content)) {
      return;
    }

    for (const part of content) {
      if (part.type === 'text' && part.text) {
        if ('aggregator' in this.config) {
          this.config.aggregator.addText(part.text);
          continue;
        }
        this.config.tracker.addText();
        const chunk = createChunk(this.config.context, { content: part.text });
        writeSSE(getStreamWriter(this.config), chunk);
      }
    }
  }
}

/**
 * Handler for run step delta events - accumulates streamed tool call fragments
 */
export class OpenAIRunStepDeltaHandler implements EventHandler {
  constructor(private toolCallStream: OpenAIToolCallStream) {}

  handle(
    _event: string,
    data: RunStepDeltaData,
    metadata?: Record<string, unknown>,
    graph?: ToolCallGraph,
  ): void {
    this.toolCallStream.onRunStepDelta(data, metadata, graph);
  }
}

/**
 * Handler for run step events - declares a tool call's id and name at its
 * outward index, before any argument fragment references that index
 */
export class OpenAIRunStepHandler implements EventHandler {
  constructor(private toolCallStream: OpenAIToolCallStream) {}

  handle(
    _event: string,
    data: RunStepData,
    metadata?: Record<string, unknown>,
    graph?: ToolCallGraph,
  ): void {
    this.toolCallStream.onRunStep(data, metadata, graph);
  }
}

/**
 * Handler for model end events - captures usage
 */
export class OpenAIModelEndHandler implements EventHandler {
  constructor(private config: OpenAIContentHandlerConfig) {}

  handle(_event: string, data: ModelEndData): void {
    const usage = data?.output?.usage_metadata;
    if (!usage) {
      return;
    }

    const target = 'aggregator' in this.config ? this.config.aggregator : this.config.tracker;
    target.usage.promptTokens += usage.input_tokens ?? 0;
    target.usage.completionTokens += usage.output_tokens ?? 0;
    target.usage.reasoningTokens +=
      usage.output_token_details?.reasoning ?? usage.output_token_details?.reasoning_tokens ?? 0;
  }
}

/**
 * Handler for chat model stream events
 */
export class OpenAIChatModelStreamHandler implements EventHandler {
  handle(): void {
    // Handled by message delta handler
  }
}

/**
 * Handler for tool end events
 */
export class OpenAIToolEndHandler implements EventHandler {
  handle(): void {
    // Tool results don't need to be streamed in OpenAI format
    // They're used internally by the agent
  }
}

/**
 * Handler for reasoning delta events.
 * Streams reasoning/thinking content using the `delta.reasoning` field (OpenRouter convention).
 */
export class OpenAIReasoningDeltaHandler implements EventHandler {
  constructor(private config: OpenAIContentHandlerConfig) {}

  handle(_event: string, data: MessageDeltaData): void {
    const content = data?.delta?.content ?? data?.content;
    if (!content || !Array.isArray(content)) {
      return;
    }

    for (const part of content) {
      if ((part.type === 'text' || part.type === 'think') && (part.think || part.text)) {
        const text = part.think || part.text!;
        if ('aggregator' in this.config) {
          this.config.aggregator.addReasoning(text);
          continue;
        }
        // Mark that reasoning was emitted
        this.config.tracker.addReasoning();

        // Stream as delta.reasoning (OpenRouter convention)
        const chunk = createChunk(this.config.context, { reasoning: text });
        writeSSE(getStreamWriter(this.config), chunk);
      }
    }
  }
}

/**
 * Create all handlers for OpenAI streaming format
 */
export interface OpenAIAggregationHandlerConfig {
  aggregator: OpenAIContentAggregator;
  signal?: AbortSignal;
}

type OpenAIContentHandlerConfig = OpenAIContentStreamConfig | OpenAIAggregationHandlerConfig;

export function createOpenAIHandlers(
  config: OpenAIContentHandlerConfig,
  toolExecuteOptions?: ToolExecuteOptions,
): Record<string, EventHandler> {
  const target = 'aggregator' in config ? config.aggregator : config.tracker;
  const toolCallProjection = createAcceptedToolCallStream({
    signal: config.signal,
    toolCalls: target.toolCalls,
    emit:
      'aggregator' in config
        ? undefined
        : (delta) => writeSSE(getStreamWriter(config), createChunk(config.context, delta)),
  });
  target.finishToolCalls = toolCallProjection.finish;
  target.abortToolCalls = toolCallProjection.abort;
  const handlers: Record<string, EventHandler> = {
    ...toolCallProjection.handlers,
    [GraphEvents.ON_MESSAGE_DELTA]: new OpenAIMessageDeltaHandler(config),
    [GraphEvents.CHAT_MODEL_END]: new OpenAIModelEndHandler(config),
    [GraphEvents.CHAT_MODEL_STREAM]: new OpenAIChatModelStreamHandler(),
    [GraphEvents.TOOL_END]: new OpenAIToolEndHandler(),
    [GraphEvents.ON_REASONING_DELTA]: new OpenAIReasoningDeltaHandler(config),
  };

  if (toolExecuteOptions) {
    handlers[GraphEvents.ON_TOOL_EXECUTE] = createToolExecuteHandler(toolExecuteOptions);
  }

  return handlers;
}

/**
 * Send the final chunk with finish_reason and optional usage
 */
export function sendFinalChunk(
  config: OpenAIContentStreamConfig,
  finishReason: ChatCompletionChunkChoice['finish_reason'] = 'stop',
  usageOverride?: CompletionUsage,
  /** True when the map contains only accepted client-owned calls, not legacy run-step history. */
  acceptedToolCallsOnly = false,
): void {
  const { context, tracker } = config;
  const writer = getStreamWriter(config);
  tracker.finishToolCalls?.();

  // Legacy run-step history followed by text stays 'stop'; accepted client calls must be executed.
  let reason = finishReason;
  if (tracker.toolCalls.size > 0 && (acceptedToolCallsOnly || !tracker.hasText)) {
    reason = 'tool_calls';
  }

  // Build usage object with reasoning token details (OpenRouter/OpenAI convention)
  const usage: CompletionUsage = usageOverride ?? {
    prompt_tokens: tracker.usage.promptTokens,
    completion_tokens: tracker.usage.completionTokens,
    total_tokens: tracker.usage.promptTokens + tracker.usage.completionTokens,
  };

  // Add reasoning token breakdown if there are reasoning tokens
  if (usageOverride == null && tracker.usage.reasoningTokens > 0) {
    usage.completion_tokens_details = {
      reasoning_tokens: tracker.usage.reasoningTokens,
    };
  }

  const finalChunk = createChunk(context, {}, reason, usage);
  writeSSE(writer, finalChunk);

  // Send [DONE] marker
  writeSSE(writer, '[DONE]');
}

/** Build provider-normalized chat-completion usage from every billed call. */
export function buildCompletionUsage(
  collectedUsage: ReadonlyArray<UsageMetadata | null | undefined>,
): CompletionUsage {
  const { total, primary, subagent } = aggregateCollectedUsage(collectedUsage);
  return {
    prompt_tokens: total.inputTokens,
    completion_tokens: total.outputTokens,
    total_tokens: total.totalTokens,
    ...(total.reasoningTokens > 0 && {
      completion_tokens_details: { reasoning_tokens: total.reasoningTokens },
    }),
    primary: {
      prompt_tokens: primary.inputTokens,
      completion_tokens: primary.outputTokens,
      total_tokens: primary.totalTokens,
    },
    subagent: {
      prompt_tokens: subagent.inputTokens,
      completion_tokens: subagent.outputTokens,
      total_tokens: subagent.totalTokens,
    },
  };
}

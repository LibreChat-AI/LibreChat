import { GraphNodeKeys } from '@librechat/agents';
import { ContentTypes, ErrorTypes } from 'librechat-data-provider';

/**
 * Gemini's raw finish reasons for a call that stopped at its output budget. `CONTINUATION` ends a
 * segment the provider expects the caller to continue, which this host cannot do yet.
 */
const TRUNCATED_FINISH_REASONS: ReadonlySet<string> = new Set(['MAX_TOKENS', 'CONTINUATION']);

interface ContentBlock {
  type?: string;
  text?: unknown;
}

export interface ModelOutputWithFinishReason {
  content?: string | readonly ContentBlock[];
  tool_calls?: readonly unknown[];
  tool_call_chunks?: readonly unknown[];
  invalid_tool_calls?: readonly unknown[];
  /**
   * Vertex AI (`@langchain/google-common`) reports `finish_reason` and stamps `finishReason: 'stop'`
   * at stream end; Google AI Studio (the `@librechat/agents` genai stream) reports `finishReason`.
   */
  response_metadata?: Record<string, unknown>;
}

/** How an answer call ended: `exhausted` hit the output budget before any answer text. */
export type ModelCallEnding = 'complete' | 'partial' | 'exhausted';

/** The latest answer call's ending per agent node, filled at model end. */
export interface OutputTruncationSink {
  calls?: Record<string, ModelCallEnding>;
}

/** A response content part as far as settling needs to write one. */
export interface TruncationContentPart {
  type?: string;
  [key: string]: unknown;
}

function isTruncatedFinishReason(value: unknown): boolean {
  return typeof value === 'string' && TRUNCATED_FINISH_REASONS.has(value.trim());
}

/** Graph metadata of a model call, as far as recording needs it. */
export interface ModelCallMetadata {
  langgraph_node?: unknown;
  last_agent_id?: unknown;
  hide_sequential_outputs?: unknown;
}

/** Summarization calls, and non-final sequential agents whose output the user never sees. */
function isUnseenCall(metadata?: ModelCallMetadata | null): boolean {
  const node = metadata?.langgraph_node;
  if (typeof node === 'string' && node.startsWith(GraphNodeKeys.SUMMARIZE)) {
    return true;
  }
  const last = metadata?.last_agent_id;
  return (
    metadata?.hide_sequential_outputs === true &&
    !(typeof node === 'string' && typeof last === 'string' && node.endsWith(last))
  );
}

/**
 * Whether a Gemini call ended at its output budget instead of finishing. A call with tool calls is
 * not an answer (Gemini sends function calls whole), so it never counts.
 */
export function isModelTruncated(output?: ModelOutputWithFinishReason | null): boolean {
  const meta = output?.response_metadata;
  if (
    !isTruncatedFinishReason(meta?.finish_reason) &&
    !isTruncatedFinishReason(meta?.finishReason)
  ) {
    return false;
  }
  return (
    (output?.tool_calls?.length ?? 0) === 0 &&
    (output?.tool_call_chunks?.length ?? 0) === 0 &&
    (output?.invalid_tool_calls?.length ?? 0) === 0
  );
}

function getAnswerText(content: ModelOutputWithFinishReason['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  let text = '';
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    }
  }
  return text;
}

/** How one model call ended, judged from that call's own output. */
export function getModelCallEnding(output?: ModelOutputWithFinishReason | null): ModelCallEnding {
  if (!isModelTruncated(output)) {
    return 'complete';
  }
  return getAnswerText(output?.content).trim() === '' ? 'exhausted' : 'partial';
}

/**
 * Records a model call's ending under its agent node, so each agent keeps only its latest call: a
 * later call that completes clears that agent's earlier truncation, parallel agents do not
 * overwrite each other, and summarization calls and hidden sequential agents are skipped. Recording never fails the run, so a
 * truncated agent cannot cut off the agents running beside or after it.
 */
export function recordModelTruncation(
  sink: OutputTruncationSink | null | undefined,
  output: ModelOutputWithFinishReason | null | undefined,
  metadata?: ModelCallMetadata | null,
): void {
  if (sink == null || isUnseenCall(metadata)) {
    return;
  }
  const node = typeof metadata?.langgraph_node === 'string' ? metadata.langgraph_node : '';
  sink.calls = { ...sink.calls, [node]: getModelCallEnding(output) };
}

/**
 * Settles a finished run's output truncation into its response, returning the fields the response
 * row persists. An agent whose latest call wrote no answer text adds an error part carrying only
 * the `output_budget_exhausted` code, after the reasoning already in `contentParts`. Otherwise an
 * answer cut off mid-way finishes as `length`, which offers Continue. A continued row finishes as
 * `stop` in every other case, so a finish reason stored by the segment it continues does not
 * survive the continuation.
 */
export function settleOutputTruncation(
  sink: OutputTruncationSink | null | undefined,
  contentParts: TruncationContentPart[],
  { continued = false }: { continued?: boolean } = {},
): { finish_reason: string } | undefined {
  const endings = Object.values(sink?.calls ?? {});
  if (endings.includes('exhausted')) {
    contentParts.push({
      type: ContentTypes.ERROR,
      [ContentTypes.ERROR]: JSON.stringify({ type: ErrorTypes.OUTPUT_BUDGET_EXHAUSTED }),
    });
  } else if (endings.includes('partial')) {
    return { finish_reason: 'length' };
  }
  return continued ? { finish_reason: 'stop' } : undefined;
}

import { ContentTypes, ToolCallTypes, getToolTimingDurations } from 'librechat-data-provider';
import type { SubagentUpdateEvent } from 'librechat-data-provider';

/**
 * Client-side helpers for rendering the live `SubagentCall` UI while
 * `ON_SUBAGENT_UPDATE` events stream in. Exports two pure transforms:
 *
 *   - `aggregateSubagentContent` — folds the raw event stream into an
 *     ordered array of TEXT / THINK / TOOL_CALL parts so the dialog can
 *     render the child's activity through the same `<Part />` pipeline
 *     the parent conversation uses. Frontend-only: on the backend we
 *     fold directly into the SDK's `createContentAggregator` in the
 *     `ON_SUBAGENT_UPDATE` handler, so no shared aggregator is needed.
 *   - `buildSubagentTickerLines` — short, user-readable status lines
 *     for the collapsed ticker. Aggregates message/reasoning deltas
 *     into running previews, surfaces tool-call lifecycle with
 *     args/output snippets, drops low-signal events.
 */

type RunStepData = {
  id?: string;
  stepDetails?: {
    type?: string;
    message_creation?: {
      phase?: 'commentary' | 'final_answer';
    };
    tool_calls?: Array<{
      id?: string;
      name?: string;
      args?: unknown;
      type?: string;
    }>;
  };
};

type RunStepCompletedData = {
  result?: {
    id?: string;
    completed_at?: number;
    type?: string;
    tool_call?: {
      id?: string;
      name?: string;
      args?: unknown;
      output?: string;
      progress?: number;
      inputValidationError?: true;
    };
  };
};

type RunStepClosedData = {
  id?: string;
};

type ToolDispatchData = {
  dispatched_at?: number;
  toolCalls?: Array<{ id?: string; stepId?: string }>;
};

type ToolPreparationData = {
  id?: string;
  toolCallId?: string;
  observed_at?: number;
};

type MessageDeltaData = {
  id?: string;
  delta?: {
    content?: Array<{
      type?: string;
      text?: string;
      phase?: 'commentary' | 'final_answer';
    }>;
  };
};

type ReasoningDeltaData = {
  delta?: { content?: Array<{ type?: string; think?: string }> };
};

type ErrorData = { message?: string };

type AssistantTextPhase = 'commentary' | 'final_answer';
type TextPart = { type: ContentTypes.TEXT; text: string; phase?: AssistantTextPhase };
type ThinkPart = { type: ContentTypes.THINK; think: string };
type ToolCallPart = {
  type: ContentTypes.TOOL_CALL;
  tool_call: {
    id: string;
    name: string;
    args: string;
    output?: string;
    progress: number;
    inputValidationError?: true;
    type?: string;
    stepId?: string;
    toolPreparationStartedAt?: number;
    toolDispatchedAt?: number;
    toolPreparationDurationMs?: number;
    toolExecutionDurationMs?: number;
  };
};

/** Single content-part-shaped entry produced by the aggregator. The union
 *  matches the subset of `TMessageContentParts` a subagent run emits. */
export type SubagentContentPart = TextPart | ThinkPart | ToolCallPart;

const extractTextChunk = (
  data: MessageDeltaData | undefined,
): { text: string; phase?: AssistantTextPhase } => {
  const content = data?.delta?.content;
  if (!Array.isArray(content)) return { text: '' };
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const phase = block.phase;
      return {
        text: block.text,
        ...(phase === 'commentary' || phase === 'final_answer' ? { phase } : {}),
      };
    }
  }
  return { text: '' };
};

const extractThinkChunk = (data: ReasoningDeltaData | undefined): string => {
  const content = data?.delta?.content;
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (block?.type === 'think' && typeof block.think === 'string') {
      return block.think;
    }
  }
  return '';
};

const stringifyArgs = (args: unknown): string =>
  typeof args === 'string' ? args : JSON.stringify(args ?? {});

const updateMessagePhase = (
  phases: Record<string, AssistantTextPhase>,
  stepId: string,
  phase: AssistantTextPhase | undefined,
): Record<string, AssistantTextPhase> => {
  const next = { ...phases };
  if (phase == null) delete next[stepId];
  else next[stepId] = phase;
  return next;
};

/**
 * Cursor carried across `foldSubagentEvent` calls so the aggregator can
 * extend an in-flight TEXT/THINK run without re-scanning earlier parts
 * on every event. `null` means the corresponding buffer is closed;
 * otherwise it's the index of the still-growing part in `contentParts`.
 */
export interface SubagentAggregatorState {
  /** Index of the currently-open TEXT part, or `null` when none. */
  openTextIdx: number | null;
  /** Index of the currently-open THINK part, or `null` when none. */
  openThinkIdx: number | null;
  /**
   * Active message-step ID to its declared text phase; graph members can
   * overlap. Entries leave on `run_step_closed`, so the runtime's bounded
   * concurrent graph width—not historical step count—bounds this table.
   */
  messagePhaseByStepId: Record<string, AssistantTextPhase>;
  /** Compatibility phase for legacy message events that omit their step ID. */
  idlessTextPhase?: AssistantTextPhase;
  /** `tool_call.id` → its index in `contentParts` for O(1) updates. */
  toolCallIndexById: Record<string, number>;
}

/** Initial empty aggregator state. */
export function initSubagentAggregatorState(): SubagentAggregatorState {
  return {
    openTextIdx: null,
    openThinkIdx: null,
    messagePhaseByStepId: {},
    toolCallIndexById: {},
  };
}

/**
 * Incrementally fold a single {@link SubagentUpdateEvent} into an existing
 * `contentParts` array, returning a new array + updated cursor state.
 * Pure function — never mutates inputs.
 *
 * Adjacent `message_delta` / `reasoning_delta` events extend the in-flight
 * TEXT / THINK part (tracked via the open*Idx cursors). When a delta
 * type switches, the opposite buffer is closed first so chronological
 * order is preserved — what the user saw is what lands in the array.
 *
 * `run_step` with `tool_calls` closes any open text/think and appends a
 * TOOL_CALL part per unique id. `run_step_completed` updates the matching
 * TOOL_CALL (output + progress). Late-arriving completions without a
 * prior `run_step` synthesize the part. `start` / `stop` / `error` /
 * `run_step_delta` contribute nothing to content.
 */
export function foldSubagentEvent(
  parts: SubagentContentPart[],
  state: SubagentAggregatorState,
  event: SubagentUpdateEvent,
): { parts: SubagentContentPart[]; state: SubagentAggregatorState } {
  if (event.phase === 'message_delta') {
    const data = event.data as MessageDeltaData | undefined;
    const extracted = extractTextChunk(data);
    const chunk = extracted.text;
    if (!chunk) return { parts, state };
    const stepId = data?.id;
    const phase =
      extracted.phase ??
      (typeof stepId === 'string' && stepId !== ''
        ? state.messagePhaseByStepId[stepId]
        : state.idlessTextPhase);
    /** Reasoning→text transition: close the open THINK so the THINK part
     *  lands BEFORE the TEXT part in chronological order. */
    const afterThinkClose = state.openThinkIdx != null ? { ...state, openThinkIdx: null } : state;
    if (afterThinkClose.openTextIdx != null) {
      const idx = afterThinkClose.openTextIdx;
      const existing = parts[idx] as TextPart;
      if ((existing.phase ?? null) === (phase ?? null)) {
        const next = parts.slice();
        next[idx] = { ...existing, text: existing.text + chunk };
        return { parts: next, state: afterThinkClose };
      }
    }
    const next = parts.slice();
    const newIdx = next.length;
    next.push({
      type: ContentTypes.TEXT,
      text: chunk,
      ...(phase == null ? {} : { phase }),
    });
    return { parts: next, state: { ...afterThinkClose, openTextIdx: newIdx } };
  }

  if (event.phase === 'reasoning_delta') {
    const chunk = extractThinkChunk(event.data as ReasoningDeltaData | undefined);
    if (!chunk) return { parts, state };
    const afterTextClose = state.openTextIdx != null ? { ...state, openTextIdx: null } : state;
    if (afterTextClose.openThinkIdx != null) {
      const idx = afterTextClose.openThinkIdx;
      const existing = parts[idx] as ThinkPart;
      const next = parts.slice();
      next[idx] = { type: ContentTypes.THINK, think: existing.think + chunk };
      return { parts: next, state: afterTextClose };
    }
    const next = parts.slice();
    const newIdx = next.length;
    next.push({ type: ContentTypes.THINK, think: chunk });
    return { parts: next, state: { ...afterTextClose, openThinkIdx: newIdx } };
  }

  if (event.phase === 'run_step') {
    const data = event.data as RunStepData | undefined;
    const details = data?.stepDetails;
    if (details?.type === 'message_creation') {
      const phase = details.message_creation?.phase;
      const textPhase = phase === 'commentary' || phase === 'final_answer' ? phase : undefined;
      const stepId = data?.id;
      if (typeof stepId === 'string' && stepId !== '') {
        const messagePhaseByStepId = updateMessagePhase(
          state.messagePhaseByStepId,
          stepId,
          textPhase,
        );
        return { parts, state: { ...state, messagePhaseByStepId } };
      }
      return {
        parts,
        state: {
          ...state,
          idlessTextPhase: textPhase,
        },
      };
    }
    if (details?.type !== 'tool_calls') return { parts, state };
    const toolCalls = details.tool_calls ?? [];
    let next = parts;
    const toolCallIndexById = { ...state.toolCallIndexById };
    for (const tc of toolCalls) {
      if (typeof tc?.id !== 'string' || !tc.id || tc.id in toolCallIndexById) continue;
      if (next === parts) next = parts.slice();
      toolCallIndexById[tc.id] = next.length;
      next.push({
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: tc.id,
          ...(typeof data?.id === 'string' ? { stepId: data.id } : {}),
          name: tc.name ?? '',
          args: stringifyArgs(tc.args),
          progress: 0.1,
          type: tc.type ?? ToolCallTypes.TOOL_CALL,
        },
      });
    }
    if (next === parts) return { parts, state: { ...state, toolCallIndexById } };
    /** New tool_call parts bound any open TEXT/THINK to the run before
     *  them — close the buffers. */
    return {
      parts: next,
      state: {
        ...state,
        openTextIdx: null,
        openThinkIdx: null,
        idlessTextPhase: undefined,
        toolCallIndexById,
      },
    };
  }

  if (event.phase === 'tool_preparation') {
    const data = event.data as ToolPreparationData | undefined;
    const id = data?.toolCallId;
    const at = data?.observed_at;
    if (!id || typeof at !== 'number' || !Number.isFinite(at) || at < 0) return { parts, state };
    const idx = state.toolCallIndexById[id];
    const part = idx == null ? undefined : parts[idx];
    if (
      part?.type !== ContentTypes.TOOL_CALL ||
      part.tool_call.stepId !== data.id ||
      part.tool_call.progress >= 1
    )
      return { parts, state };
    const next = parts.slice();
    next[idx] = {
      ...part,
      tool_call: {
        ...part.tool_call,
        toolPreparationStartedAt: Math.min(part.tool_call.toolPreparationStartedAt ?? at, at),
      },
    };
    return { parts: next, state };
  }

  if (event.phase === 'tool_calls_dispatched') {
    const data = event.data as ToolDispatchData | undefined;
    const at = data?.dispatched_at;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return { parts, state };
    let next = parts;
    for (const call of data?.toolCalls ?? []) {
      if (!call.id || !call.stepId) continue;
      const idx = state.toolCallIndexById[call.id];
      const part = idx == null ? undefined : next[idx];
      if (
        part?.type !== ContentTypes.TOOL_CALL ||
        part.tool_call.stepId !== call.stepId ||
        part.tool_call.progress >= 1
      )
        continue;
      if (next === parts) next = parts.slice();
      next[idx] = {
        ...part,
        tool_call: {
          ...part.tool_call,
          toolDispatchedAt: Math.min(part.tool_call.toolDispatchedAt ?? at, at),
        },
      };
    }
    return { parts: next, state };
  }

  if (event.phase === 'run_step_completed') {
    const data = event.data as RunStepCompletedData | undefined;
    const tc = data?.result?.tool_call;
    if (typeof tc?.id !== 'string' || !tc.id) return { parts, state };
    const existingIdx = state.toolCallIndexById[tc.id];
    if (existingIdx != null) {
      const existing = parts[existingIdx] as ToolCallPart;
      const timings =
        data?.result?.id === existing.tool_call.stepId
          ? getToolTimingDurations({
              observedAt: existing.tool_call.toolPreparationStartedAt,
              dispatchedAt: existing.tool_call.toolDispatchedAt,
              completedAt: data?.result?.completed_at,
            })
          : {};
      const merged: ToolCallPart = {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          ...existing.tool_call,
          ...timings,
          ...(tc.name ? { name: tc.name } : {}),
          ...(tc.args != null ? { args: stringifyArgs(tc.args) } : {}),
          ...(tc.output != null ? { output: tc.output } : {}),
          ...(tc.inputValidationError === true ? { inputValidationError: true } : {}),
          progress: tc.progress ?? 1,
        },
      };
      const next = parts.slice();
      next[existingIdx] = merged;
      return { parts: next, state };
    }
    /** Late-arriving completion without a prior run_step — synthesize the
     *  part (and close any open buffer like run_step would). */
    const next = parts.slice();
    const newIdx = next.length;
    next.push({
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id: tc.id,
        name: tc.name ?? '',
        args: stringifyArgs(tc.args),
        output: tc.output,
        ...(tc.inputValidationError === true ? { inputValidationError: true } : {}),
        progress: tc.progress ?? 1,
        type: ToolCallTypes.TOOL_CALL,
      },
    });
    return {
      parts: next,
      state: {
        ...state,
        openTextIdx: null,
        openThinkIdx: null,
        idlessTextPhase: undefined,
        toolCallIndexById: { ...state.toolCallIndexById, [tc.id]: newIdx },
      },
    };
  }

  if (event.phase === 'run_step_closed') {
    const stepId = (event.data as RunStepClosedData | undefined)?.id;
    if (typeof stepId !== 'string' || stepId === '') return { parts, state };
    return {
      parts,
      state: {
        ...state,
        messagePhaseByStepId: updateMessagePhase(state.messagePhaseByStepId, stepId, undefined),
      },
    };
  }

  return { parts, state };
}

/**
 * Batch wrapper around {@link foldSubagentEvent}: folds an entire event
 * stream in one go and returns just the parts. Kept for tests and for
 * legacy call-sites that don't need cursor state.
 */
export function aggregateSubagentContent(events: SubagentUpdateEvent[]): SubagentContentPart[] {
  let parts: SubagentContentPart[] = [];
  let state = initSubagentAggregatorState();
  for (const event of events) {
    ({ parts, state } = foldSubagentEvent(parts, state, event));
  }
  return parts;
}

/**
 * Discriminated-union ticker line. Keeping the label tokens + body/snippets
 * separate from their rendered strings lets the caller localize at
 * render time (hooks can't live in a pure aggregator) and — more
 * importantly — lets the UI split a fixed prefix (e.g. "Writing: ")
 * from a tail-truncatable body, so the prefix never gets clipped out
 * of view when the body overflows.
 */
export type SubagentTickerLine =
  | { kind: 'writing'; body: string }
  | { kind: 'reasoning'; body: string }
  | { kind: 'using_tool'; toolNames: string[]; argsSnippet?: string }
  | { kind: 'tool_complete'; toolName: string; outputSnippet?: string }
  | { kind: 'error'; message?: string };

/** Live-update cursor carried across incremental folds. Mirrors the
 *  content-parts aggregator pattern so the atom can own the ticker
 *  state and never has to re-aggregate from a trimmed event buffer. */
export interface SubagentTickerState {
  lines: SubagentTickerLine[];
  /** Index of the in-flight 'writing' line (for in-place tail updates). */
  textLineIdx: number | null;
  /** Index of the in-flight 'reasoning' line. */
  thinkLineIdx: number | null;
  /** Whitespace-normalized message-delta accumulator. A trailing separator is
   *  retained so chunk boundaries still render as one word boundary. */
  textBuffer: string;
  thinkBuffer: string;
}

export function initSubagentTickerState(): SubagentTickerState {
  return {
    lines: [],
    textLineIdx: null,
    thinkLineIdx: null,
    textBuffer: '',
    thinkBuffer: '',
  };
}

/** Generous tail window so wide ticker containers aren't half-empty.
 *  The component applies CSS tail-ellipsis (`dir="rtl"` +
 *  `text-overflow: ellipsis`) so narrow viewports clip from the oldest
 *  side; we deliberately DON'T prepend a data-level `…` on top of that
 *  CSS ellipsis — double-eliding would render a stray dot character
 *  right next to the "Writing:" / "Reasoning:" label. */
const PREVIEW_MAX_CHARS = 300;
const PREVIEW_BUFFER_MAX_CHARS = PREVIEW_MAX_CHARS * 4;
const truncatePreview = (input: string): string => {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (normalized.length <= PREVIEW_MAX_CHARS) return normalized;
  return normalized.slice(-PREVIEW_MAX_CHARS);
};

const appendPreviewBuffer = (buffer: string, chunk: string): string => {
  const normalized = `${buffer}${chunk}`.replace(/\s+/g, ' ').trimStart();
  return normalized.length <= PREVIEW_BUFFER_MAX_CHARS
    ? normalized
    : normalized.slice(-PREVIEW_BUFFER_MAX_CHARS);
};

const SNIPPET_MAX_CHARS = 48;
/** Short head-truncation for tool args/output — caller labels what each
 *  side is. Whitespace collapsed so multi-line outputs stay one line. */
const truncateSnippet = (input: string): string => {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (normalized.length <= SNIPPET_MAX_CHARS) return normalized;
  return `${normalized.slice(0, SNIPPET_MAX_CHARS)}…`;
};

/** Best-effort, non-rendering summary of a tool's args payload. Parsed JSON
 *  is collapsed into `key=value, key=value`; everything else falls back to
 *  the raw string. Returns `''` when nothing useful is extractable. */
const summarizeArgs = (args: unknown): string => {
  if (typeof args !== 'string' || args.length === 0) return '';
  const raw = args.trim();
  if (raw.length === 0 || raw === '{}' || raw === '[]') return '';
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => {
          const valueStr = typeof v === 'string' ? v : JSON.stringify(v);
          return `${k}=${valueStr}`;
        });
      if (entries.length === 0) return '';
      return truncateSnippet(entries.join(', '));
    }
  } catch {
    /* fall through to raw-string snippet */
  }
  return truncateSnippet(raw);
};

const summarizeOutput = (output: unknown): string => {
  if (typeof output === 'string') return truncateSnippet(output);
  if (output == null) return '';
  try {
    return truncateSnippet(JSON.stringify(output));
  } catch {
    return '';
  }
};

/**
 * Incrementally fold a single {@link SubagentUpdateEvent} into the ticker
 * state. Pure — never mutates inputs. Stored in the Recoil atom so the
 * ticker always reflects the *full* run, not just the rolling event
 * window (which trims as deltas pile up and can drop earlier tool_call
 * lifecycle events).
 *
 * Message/reasoning deltas extend an in-flight line via the `textLineIdx`
 * / `thinkLineIdx` cursors. A `run_step` with tool_calls closes the
 * running buffers and appends a `using_tool` line. `run_step_completed`
 * appends a `tool_complete` line. `error` appends an `error` line.
 * Phases we ignore (`start`, `stop`, `run_step_delta`): pass-through.
 */
export function foldSubagentEventIntoTicker(
  state: SubagentTickerState,
  event: SubagentUpdateEvent,
): SubagentTickerState {
  if (event.phase === 'message_delta') {
    const chunk = extractTextChunk(event.data as MessageDeltaData | undefined).text;
    if (!chunk) return state;
    /** Delta-type transition: close any open reasoning buffer/cursor so
     *  a later `reasoning_delta` starts a NEW line below this text,
     *  rather than appending to the original reasoning line (which
     *  would produce merged / out-of-order previews). Mirrors the
     *  content-parts reducer's chronological-order rule. */
    const afterClose =
      state.thinkLineIdx != null || state.thinkBuffer
        ? { ...state, thinkLineIdx: null, thinkBuffer: '' }
        : state;
    const textBuffer = appendPreviewBuffer(afterClose.textBuffer, chunk);
    const body = truncatePreview(textBuffer);
    const line: SubagentTickerLine = { kind: 'writing', body };
    if (afterClose.textLineIdx == null) {
      const lines = afterClose.lines.concat(line);
      return { ...afterClose, textBuffer, lines, textLineIdx: lines.length - 1 };
    }
    const lines = afterClose.lines.slice();
    lines[afterClose.textLineIdx] = line;
    return { ...afterClose, textBuffer, lines };
  }

  if (event.phase === 'reasoning_delta') {
    const chunk = extractThinkChunk(event.data as ReasoningDeltaData | undefined);
    if (!chunk) return state;
    /** Symmetric: close any open text buffer/cursor. */
    const afterClose =
      state.textLineIdx != null || state.textBuffer
        ? { ...state, textLineIdx: null, textBuffer: '' }
        : state;
    const thinkBuffer = appendPreviewBuffer(afterClose.thinkBuffer, chunk);
    const body = truncatePreview(thinkBuffer);
    const line: SubagentTickerLine = { kind: 'reasoning', body };
    if (afterClose.thinkLineIdx == null) {
      const lines = afterClose.lines.concat(line);
      return { ...afterClose, thinkBuffer, lines, thinkLineIdx: lines.length - 1 };
    }
    const lines = afterClose.lines.slice();
    lines[afterClose.thinkLineIdx] = line;
    return { ...afterClose, thinkBuffer, lines };
  }

  if (event.phase === 'run_step') {
    /** A new run_step starts a fresh lifecycle marker and closes any
     *  in-flight streaming line — the delta cursors reset so the *next*
     *  message/reasoning delta starts its own line below the tool call. */
    const afterClose: SubagentTickerState = {
      ...state,
      textBuffer: '',
      thinkBuffer: '',
      textLineIdx: null,
      thinkLineIdx: null,
    };
    const data = event.data as RunStepData | undefined;
    if (data?.stepDetails?.type !== 'tool_calls') return afterClose;
    const toolCalls = data.stepDetails.tool_calls ?? [];
    const named = toolCalls.filter(
      (tc): tc is { id?: string; name: string; args?: unknown } =>
        typeof tc?.name === 'string' && tc.name.length > 0,
    );
    if (named.length === 0) return afterClose;
    const toolNames = named.slice(0, 16).map((tc) => truncateSnippet(tc.name));
    const argsSnippet = named.length === 1 ? summarizeArgs(named[0].args) : undefined;
    const line: SubagentTickerLine = {
      kind: 'using_tool',
      toolNames,
      ...(argsSnippet ? { argsSnippet } : {}),
    };
    return { ...afterClose, lines: afterClose.lines.concat(line) };
  }

  if (event.phase === 'run_step_completed') {
    const data = event.data as RunStepCompletedData | undefined;
    const tc = data?.result?.tool_call;
    if (typeof tc?.name !== 'string' || tc.name.length === 0) return state;
    const outputSnippet = tc.output != null ? summarizeOutput(tc.output) : undefined;
    const line: SubagentTickerLine = {
      kind: 'tool_complete',
      toolName: truncateSnippet(tc.name),
      ...(outputSnippet ? { outputSnippet } : {}),
    };
    return { ...state, lines: state.lines.concat(line) };
  }

  if (event.phase === 'error') {
    const data = event.data as ErrorData | undefined;
    const line: SubagentTickerLine = {
      kind: 'error',
      ...(data?.message ? { message: truncatePreview(data.message) } : {}),
    };
    return { ...state, lines: state.lines.concat(line) };
  }

  return state;
}

/**
 * Batch wrapper around {@link foldSubagentEventIntoTicker} — folds an
 * entire event stream in one shot. Kept for tests and any legacy
 * consumer that prefers a one-call API.
 */
export function buildSubagentTickerLines(events: SubagentUpdateEvent[]): SubagentTickerLine[] {
  let state = initSubagentTickerState();
  for (const event of events) {
    state = foldSubagentEventIntoTicker(state, event);
  }
  return state.lines;
}

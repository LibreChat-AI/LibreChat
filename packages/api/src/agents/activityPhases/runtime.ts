import { GraphEvents } from '@librechat/agents';
import { ContentTypes, StepTypes } from 'librechat-data-provider';
import type { EventHandler, HookCallback, HookInputByEvent } from '@librechat/agents';
import type { LooseContentPart } from '~/agents/activityLabels/wiring';
import { stringifyActivityEvidence } from '~/agents/activityLabels/runtime';

type PostToolBatchInput = HookInputByEvent['PostToolBatch'];
type BatchEntry = PostToolBatchInput['entries'][number];
type AssistantContextEntry = { stepId?: string; text: string; activityPosition?: number };

export type AssistantTextPhase = 'commentary' | 'final_answer';

export interface ActivityPhaseEntry {
  label?: string;
  entries?: Array<{
    toolName: string;
    toolInput: unknown;
    toolOutput?: unknown;
    error?: string;
    status: 'success' | 'error';
  }>;
  thinkingExcerpts?: string[];
  agentId?: string;
  status?: 'success' | 'partial' | 'error';
}

export type TrackedActivity = ActivityPhaseEntry & {
  startIndex: number;
  /** A prior boundary can retain only the materialized tail of a straddling batch. */
  partitionStartIndex?: number;
  /** Anchor-only activities keep position and status but carry no prompt evidence. */
  bounded?: boolean;
  /** Activities folded into this anchor once the anchor budget was reached.
   *  Every counted activity therefore keeps a position, so a boundary can
   *  partition counts instead of reconstructing them by subtraction. */
  mergedCount?: number;
  mergedFailedCount?: number;
  mergedPartialCount?: number;
  /** Agents whose activities were folded into this anchor, so attribution and
   *  the summarizer payload keep every contributor the count represents. */
  mergedAgentIds?: string[];
  childLabelIndex?: number;
  /** Stable anchors survive content filtering and prepends across HITL resume. */
  toolCallIds?: string[];
  /** Original boundary retained while only part of a saved tool batch is materialized. */
  unresolvedToolStartIndex?: number;
};

export interface ActivityPhaseSnapshot {
  /** Version 2 introduces object-valued assistant context and overflow anchors.
   *  Version 3 folds those anchors into `activities` so every counted activity
   *  carries a position; readers still accept 1 and 2. */
  version: 1 | 2 | 3;
  generated: number;
  /** @deprecated Version 3 derives the total from positioned activities. */
  activityCount: number;
  /** @deprecated Version 3 derives failures from positioned activities. */
  failedActivityCount: number;
  /** @deprecated Version 3 derives partials from positioned activities. */
  partialActivityCount: number;
  agentIds: string[];
  activities: TrackedActivity[];
  overflowActivityStartIndex?: number;
  overflowToolCallIds?: string[];
  /** IDs tied to the saved numeric overflow boundary, including equal-index batches. */
  overflowBoundaryToolCallIds?: string[];
  /** @deprecated Stable anchor retained for snapshots created before multi-anchor support. */
  overflowReasoningExcerpt?: string;
  /** Bounded stable anchors for reasoning-only overflow after HITL content compaction. */
  overflowReasoningAnchors?: string[];
  /** Lightweight anchors retain per-activity partitioning beyond prompt evidence limits. */
  overflowActivities?: TrackedActivity[];
  assistantContext: Array<string | { text: string; activityPosition: number }>;
  pendingReasoning: Array<{
    key: string;
    text: string;
    agentId?: string;
    startIndex?: number;
  }>;
}

export interface GenerateActivityPhasePayload {
  activities: ActivityPhaseEntry[];
  assistantContext?: string[];
  closingTextPhase?: AssistantTextPhase;
  phaseIndex: number;
  totalActivityCount: number;
  status: 'completed' | 'partial' | 'failed';
  agentIds: string[];
  charLimit: number;
  prompt?: string;
  signal: AbortSignal;
}

export interface GeneratedActivityPhase {
  label?: string;
  collectUsage?: (label?: string) => void | Promise<void>;
}

export interface ActivityPhaseHostDeps {
  maxPerRun?: number;
  charLimit?: number;
  prompt?: string;
  abortSignal?: AbortSignal;
  initialSnapshot?: ActivityPhaseSnapshot;
  getContentParts: () => Array<LooseContentPart | null | undefined>;
  getStepIndex?: (stepId: string) => number | undefined;
  bumpIndexOffset: () => void;
  emitLabelEvent: (index: number, part: LooseContentPart) => Promise<unknown>;
  trackPendingFill: (fillDone: Promise<void>) => void;
  isClosed?: () => boolean;
  generatePhase: (payload: GenerateActivityPhasePayload) => Promise<GeneratedActivityPhase>;
}

export interface ActivityPhaseWiring {
  hook: HookCallback<'PostToolBatch'>;
  handlers: (
    handlers: Record<string, EventHandler> | undefined,
  ) => Record<string, EventHandler> | undefined;
  /** A steer is a hard semantic boundary; incomplete evidence is discarded. */
  drop: () => void;
  /** Finalizes unphased evidence once the root AgentRun has actually completed. */
  complete: () => void;
  /** Bounded state needed to continue the same phase after a HITL pause. */
  snapshot: () => ActivityPhaseSnapshot;
}

const DEFAULT_MAX_PER_RUN = 5;
const DEFAULT_CHAR_LIMIT = 600;
const MIN_ACTIVITIES = 2;
const MAX_CONTEXT_ITEMS = 6;
const MAX_EXCERPT_CHARS = 600;
const REASONING_ANCHOR_CHARS = 80;
const SUBSTANTIAL_TEXT_CHARS = 200;
const OUTPUT_CHAR_LIMIT = 160;
const PHASE_TIMEOUT_MS = 12_000;
/** Twelve enter the SDK prompt; one extra preserves its omitted-activity row. */
const MAX_RETAINED_ACTIVITIES = 13;
const MAX_RETAINED_TOOL_ENTRIES = 6;
const MAX_OVERFLOW_ACTIVITY_ANCHORS = 64;

export const ACTIVITY_PHASE_INSTRUCTION = `Summarize what this phase of an agent run accomplished. The result appears as the header of one collapsed parent group containing several activities.

Rules:
- One line, 8 to 18 words, past tense
- Lead with the concrete outcome and name the most distinctive subject
- Synthesize the phase; do not enumerate, count, or restate individual activities
- Describe failures plainly when they are the phase's material outcome
- Never mention tool names, calls, arguments, reasoning, commentary, or activity counts
- Output only the summary — no quotes, no trailing punctuation, no preamble

Examples:
- Reconciled authentication behavior and fixed the failing session refresh path
- Compared deployment options and documented the safest production rollout
- Investigated database latency but could not confirm the suspected index regression

Bad examples:
- Used three tools to inspect files and run tests
- Searched code, read configuration, and updated middleware`;

interface DeltaPart {
  text?: unknown;
  think?: unknown;
}

function textValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const nested = (value as { value?: unknown } | null | undefined)?.value;
  return typeof nested === 'string' ? nested : '';
}

function isSubstantialText(part: LooseContentPart | null | undefined): boolean {
  return (
    part?.type === ContentTypes.TEXT && textValue(part.text).trim().length > SUBSTANTIAL_TEXT_CHARS
  );
}

function normalizeLabel(value: string | undefined): string {
  const firstLine = value?.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  const normalized = firstLine.replace(/\s+/g, ' ').trim();
  return normalized.length > OUTPUT_CHAR_LIMIT
    ? `${normalized.slice(0, OUTPUT_CHAR_LIMIT - 1)}…`
    : normalized;
}

function deltaText(data: unknown, key: 'text' | 'think'): string {
  const raw = (data as { delta?: { content?: unknown } } | null)?.delta?.content;
  let parts: unknown[] = [];
  if (Array.isArray(raw)) {
    parts = raw;
  } else if (raw != null) {
    parts = [raw];
  }
  return parts.map((part) => textValue((part as DeltaPart | null)?.[key])).join('');
}

function buildSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PHASE_TIMEOUT_MS);
  return signal != null && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeout])
    : timeout;
}

function definedPartIndices(parts: ReadonlyArray<LooseContentPart | null | undefined>): number[] {
  return Object.keys(parts).map(Number);
}

function findLastPartIndex(
  parts: ReadonlyArray<LooseContentPart | null | undefined>,
  type: string,
): number {
  const indices = definedPartIndices(parts);
  for (let position = indices.length - 1; position >= 0; position -= 1) {
    const index = indices[position];
    if (parts[index]?.type === type) {
      return index;
    }
  }
  return Math.max(0, parts.length - 1);
}

function findTrackedStart(
  parts: ReadonlyArray<LooseContentPart | null | undefined>,
  activity: TrackedActivity,
): number {
  const materializedStart = findMaterializedActivityStart(parts, activity);
  const startIndex =
    materializedStart ?? Math.min(activity.startIndex, Math.max(0, parts.length - 1));
  return Math.max(startIndex, activity.partitionStartIndex ?? 0);
}

function findMaterializedActivityStart(
  parts: ReadonlyArray<LooseContentPart | null | undefined>,
  activity: TrackedActivity,
  toolIndices?: number[],
): number | undefined {
  const toolStart = (toolIndices ?? findTrackedToolIndices(parts, activity))[0];
  if (toolStart != null) {
    return toolStart;
  }
  const excerpt = activity.thinkingExcerpts?.[0]?.trim();
  if (excerpt) {
    const reasoningStart = findReasoningStart(parts, excerpt, activity.startIndex);
    if (
      parts[reasoningStart]?.type === ContentTypes.THINK &&
      textValue(parts[reasoningStart]?.think).includes(
        excerpt.trim().slice(0, REASONING_ANCHOR_CHARS),
      )
    ) {
      return reasoningStart;
    }
  }
  return undefined;
}

type ReasoningAnchorIndex = Map<number, Set<string>>;

function addReasoningAnchor(
  anchors: Set<string>,
  index: ReasoningAnchorIndex,
  excerpt: string,
): void {
  const anchor = excerpt.trim().slice(0, REASONING_ANCHOR_CHARS);
  if (!anchor || anchors.has(anchor)) {
    return;
  }
  anchors.add(anchor);
  const matchingLength = index.get(anchor.length);
  if (matchingLength != null) {
    matchingLength.add(anchor);
  } else {
    index.set(anchor.length, new Set([anchor]));
  }
  while (anchors.size > MAX_OVERFLOW_ACTIVITY_ANCHORS) {
    const oldest = anchors.values().next().value as string | undefined;
    if (oldest == null) {
      break;
    }
    anchors.delete(oldest);
    const matchingLength = index.get(oldest.length);
    matchingLength?.delete(oldest);
    if (matchingLength?.size === 0) {
      index.delete(oldest.length);
    }
  }
}

function includesReasoningAnchor(text: string, index: ReasoningAnchorIndex): boolean {
  for (const [length, anchors] of index) {
    for (let offset = 0; offset <= text.length - length; offset += 1) {
      if (anchors.has(text.slice(offset, offset + length))) {
        return true;
      }
    }
  }
  return false;
}

function findTrackedToolIndices(
  parts: ReadonlyArray<LooseContentPart | null | undefined>,
  activity: TrackedActivity,
): number[] {
  if (activity.toolCallIds == null || activity.toolCallIds.length === 0) {
    return [];
  }
  const ids = new Set(activity.toolCallIds);
  return definedPartIndices(parts).filter((index) => {
    const part = parts[index];
    return (
      part?.type === ContentTypes.TOOL_CALL &&
      typeof part.tool_call?.id === 'string' &&
      ids.has(part.tool_call.id)
    );
  });
}

function findReasoningStart(
  parts: ReadonlyArray<LooseContentPart | null | undefined>,
  text: string,
  startIndex?: number,
): number {
  const needle = text.trim().slice(0, 80);
  const matches = (part: LooseContentPart | null | undefined) =>
    part?.type === ContentTypes.THINK && textValue(part.think).includes(needle);
  if (startIndex != null && matches(parts[startIndex])) {
    return startIndex;
  }
  for (const index of definedPartIndices(parts)) {
    if (matches(parts[index])) {
      return index;
    }
  }
  return startIndex ?? findLastPartIndex(parts, ContentTypes.THINK);
}

/**
 * Locates a captured text entry in the live content, reporting whether the
 * result is authoritative. A step index anchors it exactly; a bare text match
 * only does when it is unique, because a repeated excerpt would otherwise
 * resolve to the wrong occurrence and outrank the position it was saved with.
 */
function locateTextEntry(
  parts: ReadonlyArray<LooseContentPart | null | undefined>,
  text: string,
  stepIndex?: number,
): { index?: number; authoritative: boolean } {
  const needle = text.trim().slice(-REASONING_ANCHOR_CHARS);
  if (!needle) {
    return { index: stepIndex, authoritative: false };
  }
  const matches = (part: LooseContentPart | null | undefined) =>
    part?.type === ContentTypes.TEXT && textValue(part.text).includes(needle);
  if (stepIndex != null && matches(parts[stepIndex])) {
    return { index: stepIndex, authoritative: true };
  }
  let lastMatch: number | undefined;
  let matchCount = 0;
  for (const index of definedPartIndices(parts)) {
    if (matches(parts[index])) {
      lastMatch = index;
      matchCount += 1;
    }
  }
  return { index: lastMatch, authoritative: matchCount === 1 };
}

function findTextBoundary(
  parts: ReadonlyArray<LooseContentPart | null | undefined>,
  text: string,
  stepIndex?: number,
): number | undefined {
  return locateTextEntry(parts, text, stepIndex).index;
}

/** Persists Open Responses text-phase metadata onto LibreChat text parts.
 *  Installed for existing batch labels too, so commentary can supply intent
 *  even when parent phase summaries are disabled. */
export function createAssistantPhaseStampingHandlers(
  handlers: Record<string, EventHandler> | undefined,
): Record<string, EventHandler> | undefined {
  if (handlers == null) {
    return handlers;
  }
  const phases = new Map<string, AssistantTextPhase>();
  const wrapped = { ...handlers };
  const runStepHandler = handlers[GraphEvents.ON_RUN_STEP];
  if (runStepHandler != null) {
    wrapped[GraphEvents.ON_RUN_STEP] = {
      handle: (event, data, metadata, graph) => {
        const step = data as {
          id?: string;
          stepDetails?: { message_creation?: { phase?: string } };
        };
        const phase = step.stepDetails?.message_creation?.phase;
        if (step.id && (phase === 'commentary' || phase === 'final_answer')) {
          phases.set(step.id, phase);
        }
        return runStepHandler.handle(event, data, metadata, graph);
      },
    };
  }
  const messageHandler = handlers[GraphEvents.ON_MESSAGE_DELTA];
  if (messageHandler != null) {
    wrapped[GraphEvents.ON_MESSAGE_DELTA] = {
      handle: (event, data, metadata, graph) => {
        const phase = phases.get((data as { id?: string }).id ?? '');
        const delta = (data as { delta?: { content?: unknown } }).delta;
        const raw = delta?.content;
        if (phase == null || raw == null) {
          return messageHandler.handle(event, data, metadata, graph);
        }
        const stamp = (part: unknown) =>
          (part as { type?: string } | null)?.type === ContentTypes.TEXT
            ? { ...(part as Record<string, unknown>), phase }
            : part;
        const forwarded = Object.assign({}, data, {
          delta: {
            ...delta,
            content: Array.isArray(raw) ? raw.map(stamp) : stamp(raw),
          },
        });
        return messageHandler.handle(event, forwarded, metadata, graph);
      },
    };
  }
  return wrapped;
}

type PendingReasoning = { text: string; agentId?: string; startIndex?: number };

/** One side of a boundary split. Every piece of run state that a phase can
 *  own appears here, so adding tracked state without partitioning it is a
 *  type error rather than a silently mis-grouped activity. */
interface PhasePartitionSide {
  activities: TrackedActivity[];
  context: AssistantContextEntry[];
  pendingReasoning: Array<readonly [string, PendingReasoning]>;
  reasoningStepKeys: Array<readonly [string, string]>;
}

interface PhasePartition {
  closing: PhasePartitionSide;
  retained: PhasePartitionSide;
}

/**
 * Where an activity sits in the live content, resolved once. Positional fields
 * on `TrackedActivity` are captured at different times against an array that
 * keeps moving — parts materialize after their hooks fire, label reservations
 * shift indices, persistence compacts, resume prepends — so each is an input
 * here rather than something a boundary consults directly.
 */
interface ResolvedPosition {
  /** Materialized indices of this activity's tool calls, ascending. */
  toolIndices: number[];
  /** Where the activity begins once anchors and prior floors are applied. */
  startsAt: number;
  /** The highest index this activity is known to reach, including a saved
   *  fallback for calls that have not materialized yet. `undefined` when
   *  nothing in the live content locates it at all. */
  endsAt?: number;
  /** Whether the saved fallback is still doing work. Once every tracked call
   *  has materialized it is stale, and persisting it would hold the activity
   *  past a boundary its real position precedes after a resume. */
  awaitingTools: boolean;
}

function resolvePosition(
  parts: ReadonlyArray<LooseContentPart | null | undefined>,
  activity: TrackedActivity,
): ResolvedPosition {
  const toolIndices = findTrackedToolIndices(parts, activity);
  const toolStart = toolIndices[0];
  /** A saved fallback outlives its purpose once every tracked call has
   *  materialized; keeping it would hold the activity past a boundary its
   *  real position precedes. */
  const trackedToolCount = activity.toolCallIds?.length ?? 0;
  const awaitingTools = trackedToolCount === 0 || toolIndices.length < trackedToolCount;
  const fallback = awaitingTools ? activity.unresolvedToolStartIndex : undefined;
  if (toolStart != null) {
    return {
      toolIndices,
      awaitingTools,
      startsAt: Math.max(toolStart, activity.partitionStartIndex ?? 0),
      endsAt: Math.max(toolIndices[toolIndices.length - 1], fallback ?? Number.NEGATIVE_INFINITY),
    };
  }
  /** Anchors carry only stable evidence and must be re-located against the
   *  current content; a full activity keeps the index maintained live, which
   *  repeated reasoning must not drag back across a prior phase. */
  const startsAt =
    activity.bounded === true ? findTrackedStart(parts, activity) : activity.startIndex;
  const materializedStart = findMaterializedActivityStart(parts, activity, toolIndices);
  const located =
    fallback != null ? Math.max(fallback, materializedStart ?? fallback) : materializedStart;
  return { toolIndices, awaitingTools, startsAt, ...(located != null && { endsAt: located }) };
}

/**
 * Whether an activity belongs to the phase closing at `boundary`. Takes only a
 * resolved position, so no caller can reach past it to a raw field: an
 * activity closes early exactly when nothing locates it beyond the boundary.
 * A completed batch straddling the boundary therefore stays whole on the later
 * side rather than leaving one tool call outside its own parent.
 */
function closesBeforeBoundary(position: ResolvedPosition, boundary: number | undefined): boolean {
  if (boundary == null) {
    return true;
  }
  return position.endsAt == null || position.endsAt < boundary;
}

/**
 * Every field of a bounded anchor, stated explicitly. Anchors are built by
 * demoting an activity and by folding two together, and both used to spread
 * one side and hand-pick the rest — so any field nobody named was dropped
 * silently, and nothing failed until a boundary happened to land badly.
 * Mapping over `keyof Required<TrackedActivity>` makes every field mandatory
 * at the construction site: adding one to `TrackedActivity` is a type error
 * until its anchor semantics are decided here.
 */
type AnchorFields = { [K in keyof Required<TrackedActivity>]: TrackedActivity[K] };

function laterDefinedIndex(earlier?: number, later?: number): number | undefined {
  if (earlier == null) {
    return later;
  }
  return later == null ? earlier : Math.max(earlier, later);
}

function foldedAgentIds(earlier: TrackedActivity, later: TrackedActivity): string[] | undefined {
  const folded = [
    ...new Set(
      [
        ...(earlier.mergedAgentIds ?? []),
        ...(earlier.agentId != null ? [earlier.agentId] : []),
        ...(later.mergedAgentIds ?? []),
        ...(later.agentId != null ? [later.agentId] : []),
      ].filter((id) => id !== earlier.agentId),
    ),
  ];
  return folded.length > 0 ? folded : undefined;
}

/** Strips prompt evidence while keeping everything a boundary reasons about. */
function boundedAnchor(activity: TrackedActivity): TrackedActivity {
  const fields: AnchorFields = {
    startIndex: activity.startIndex,
    bounded: true,
    status: activity.status,
    partitionStartIndex: activity.partitionStartIndex,
    unresolvedToolStartIndex: activity.unresolvedToolStartIndex,
    toolCallIds: activity.toolCallIds?.slice(-MAX_RETAINED_TOOL_ENTRIES),
    thinkingExcerpts: activity.thinkingExcerpts
      ?.slice(-MAX_RETAINED_TOOL_ENTRIES)
      .map((text) => text.slice(-REASONING_ANCHOR_CHARS)),
    agentId: activity.agentId,
    mergedCount: activity.mergedCount,
    mergedFailedCount: activity.mergedFailedCount,
    mergedPartialCount: activity.mergedPartialCount,
    mergedAgentIds: activity.mergedAgentIds,
    /** An anchor is never summarized directly, so prompt evidence and the
     *  child-label slot are deliberately not carried. */
    label: undefined,
    entries: undefined,
    childLabelIndex: undefined,
  };
  return fields;
}

/** Folds `later` into `earlier`, which keeps its position. */
function mergeAnchors(earlier: TrackedActivity, later: TrackedActivity): TrackedActivity {
  const mergedFailedCount = countFailedActivities([earlier, later]);
  const mergedPartialCount = countPartialActivities([earlier, later]);
  const excerpts =
    earlier.thinkingExcerpts != null || later.thinkingExcerpts != null
      ? [...(earlier.thinkingExcerpts ?? []), ...(later.thinkingExcerpts ?? [])].slice(
          -MAX_RETAINED_TOOL_ENTRIES,
        )
      : undefined;
  const fields: AnchorFields = {
    /** The pair starts where its first activity did; the later side's floor
     *  describes a position being absorbed and must not move the survivor. */
    startIndex: earlier.startIndex,
    partitionStartIndex: earlier.partitionStartIndex,
    bounded: true,
    status: earlier.status,
    /** The later side may still be waiting on a tool call. Dropping its
     *  fallback lets a boundary close the whole merged count on the earlier
     *  side; resolution clears it once every retained id materializes. */
    unresolvedToolStartIndex: laterDefinedIndex(
      earlier.unresolvedToolStartIndex,
      later.unresolvedToolStartIndex,
    ),
    toolCallIds: [...(earlier.toolCallIds ?? []), ...(later.toolCallIds ?? [])].slice(
      -MAX_RETAINED_TOOL_ENTRIES,
    ),
    thinkingExcerpts: excerpts,
    agentId: earlier.agentId,
    mergedCount: (earlier.mergedCount ?? 1) + (later.mergedCount ?? 1),
    mergedFailedCount: mergedFailedCount > 0 ? mergedFailedCount : undefined,
    mergedPartialCount: mergedPartialCount > 0 ? mergedPartialCount : undefined,
    mergedAgentIds: foldedAgentIds(earlier, later),
    label: undefined,
    entries: undefined,
    childLabelIndex: undefined,
  };
  return fields;
}

/** Every activity is represented by exactly one positioned item, so run totals
 *  are a sum over that list rather than a separately maintained scalar. */
function countActivities(activities: ReadonlyArray<TrackedActivity>): number {
  return activities.reduce((total, activity) => total + (activity.mergedCount ?? 1), 0);
}

function countFailedActivities(activities: ReadonlyArray<TrackedActivity>): number {
  return activities.reduce((total, activity) => {
    if (activity.mergedCount == null) {
      return total + (activity.status === 'error' ? 1 : 0);
    }
    return total + (activity.mergedFailedCount ?? 0);
  }, 0);
}

function countPartialActivities(activities: ReadonlyArray<TrackedActivity>): number {
  return activities.reduce((total, activity) => {
    if (activity.mergedCount == null) {
      return total + (activity.status === 'partial' ? 1 : 0);
    }
    return total + (activity.mergedPartialCount ?? 0);
  }, 0);
}

/**
 * Rebuilds the unpositioned remainder of a version 1 or 2 snapshot as one
 * bounded anchor at the saved overflow position, so aggregate counts survive
 * without a scalar the boundary partition cannot place.
 */
function restoreLegacyOverflowAnchors(
  content: ReadonlyArray<LooseContentPart | null | undefined>,
  snapshot: ActivityPhaseSnapshot | undefined,
): TrackedActivity[] {
  if (snapshot == null || snapshot.version === 3) {
    return [];
  }
  const positioned = snapshot.activities.length + (snapshot.overflowActivities?.length ?? 0);
  const remainder = Math.max(0, snapshot.activityCount - positioned);
  if (remainder === 0) {
    return [];
  }
  const toolCallIds = snapshot.overflowToolCallIds ?? [];
  const boundaryToolCallIds = snapshot.overflowBoundaryToolCallIds ?? toolCallIds;
  const reasoningAnchors =
    snapshot.overflowReasoningAnchors ??
    (snapshot.overflowReasoningExcerpt != null ? [snapshot.overflowReasoningExcerpt] : []);
  const anchorIndex: ReasoningAnchorIndex = new Map();
  const anchors = new Set<string>();
  for (const anchor of reasoningAnchors) {
    addReasoningAnchor(anchors, anchorIndex, anchor);
  }
  const materializedToolIds = new Set<string>();
  const matchedTools: Array<{ index: number; id: string }> = [];
  let matchedReasoningIndex: number | undefined;
  for (const index of definedPartIndices(content)) {
    const part = content[index];
    const toolCallId = part?.type === ContentTypes.TOOL_CALL ? part.tool_call?.id : undefined;
    if (typeof toolCallId === 'string' && toolCallIds.includes(toolCallId)) {
      materializedToolIds.add(toolCallId);
      matchedTools.push({ index, id: toolCallId });
    }
    if (
      anchors.size > 0 &&
      part?.type === ContentTypes.THINK &&
      includesReasoningAnchor(textValue(part.think), anchorIndex)
    ) {
      matchedReasoningIndex = index;
    }
  }
  const rebased =
    matchedTools.length > 0
      ? Math.max(...matchedTools.map(({ index }) => index), matchedReasoningIndex ?? -1)
      : matchedReasoningIndex;
  const hasUnresolvedBoundaryTool = boundaryToolCallIds.some((id) => !materializedToolIds.has(id));
  /** A saved position only survives when something still locates it. An anchor
   *  whose evidence was filtered out of the compacted content is stale, and
   *  counting it would inflate a resumed phase with work it cannot show. */
  const resolvedStartIndex = hasUnresolvedBoundaryTool
    ? Math.max(rebased ?? -1, snapshot.overflowActivityStartIndex ?? -1)
    : (rebased ?? (anchors.size === 0 ? snapshot.overflowActivityStartIndex : undefined));
  if (resolvedStartIndex == null || resolvedStartIndex < 0) {
    return [];
  }
  const positionedFailed =
    snapshot.activities.filter((activity) => activity.status === 'error').length +
    (snapshot.overflowActivities ?? []).filter((activity) => activity.status === 'error').length;
  const positionedPartial =
    snapshot.activities.filter((activity) => activity.status === 'partial').length +
    (snapshot.overflowActivities ?? []).filter((activity) => activity.status === 'partial').length;
  const mergedFailedCount = Math.min(
    remainder,
    Math.max(0, snapshot.failedActivityCount - positionedFailed),
  );
  const mergedPartialCount = Math.min(
    remainder - mergedFailedCount,
    Math.max(0, snapshot.partialActivityCount - positionedPartial),
  );
  const uniformStatus = (): TrackedActivity['status'] => {
    if (mergedFailedCount === remainder) {
      return 'error';
    }
    return mergedPartialCount === remainder ? 'partial' : 'success';
  };
  /** The scalar remainder is only splittable where its evidence is. When every
   *  saved boundary tool materialized, spread it across those positions so a
   *  persisted boundary between two of them partitions the count instead of
   *  dragging all of it to the latest side. An unresolved boundary tool means
   *  the saved position is still a fallback, which stays atomic. */
  const splittable = !hasUnresolvedBoundaryTool && matchedTools.length > 1 && remainder > 1;
  /** Each split anchor keeps the tool id that materialized at its own
   *  position; without one it cannot be located and would collapse onto the
   *  earlier side of every boundary. */
  const anchorPoints = splittable
    ? matchedTools.filter(({ index }) => index <= resolvedStartIndex)
    : [{ index: resolvedStartIndex, id: undefined as string | undefined }];
  const shares = Math.min(anchorPoints.length, remainder);
  if (shares < anchorPoints.length) {
    anchorPoints.splice(0, anchorPoints.length - shares);
  }
  const perShare = Math.floor(remainder / shares);
  let remainingFailed = mergedFailedCount;
  let remainingPartial = mergedPartialCount;
  return anchorPoints.slice(0, shares).map(({ index: startIndex, id }, position) => {
    const isLast = position === shares - 1;
    const mergedCount = isLast ? remainder - perShare * (shares - 1) : perShare;
    const failed = Math.min(remainingFailed, mergedCount);
    remainingFailed -= failed;
    const partial = Math.min(remainingPartial, mergedCount - failed);
    remainingPartial -= partial;
    const splitStatus = (): TrackedActivity['status'] => {
      if (shares === 1) {
        return uniformStatus();
      }
      return failed === mergedCount ? 'error' : 'success';
    };
    const status = splitStatus();
    return {
      startIndex,
      bounded: true,
      mergedCount,
      status,
      ...(id != null && { toolCallIds: [id] }),
      ...(id == null &&
        toolCallIds.length > 0 && { toolCallIds: toolCallIds.slice(-MAX_RETAINED_TOOL_ENTRIES) }),
      ...(isLast &&
        reasoningAnchors.length > 0 && {
          thinkingExcerpts: reasoningAnchors.slice(-MAX_RETAINED_TOOL_ENTRIES),
        }),
      ...(failed > 0 && { mergedFailedCount: failed }),
      ...(partial > 0 && { mergedPartialCount: partial }),
      ...(isLast && hasUnresolvedBoundaryTool && { unresolvedToolStartIndex: resolvedStartIndex }),
    };
  });
}

/**
 * Collects run-wide logical activities and emits one parent summary at an
 * explicit final-answer boundary or root-run completion. The summary call is
 * detached; final-answer streams only pay the synchronous slot reservation.
 */
export function createActivityPhaseWiring(deps: ActivityPhaseHostDeps): ActivityPhaseWiring {
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const charLimit = deps.charLimit ?? DEFAULT_CHAR_LIMIT;
  const content = deps.getContentParts();
  const initialSnapshot =
    deps.initialSnapshot?.version === 1 ||
    deps.initialSnapshot?.version === 2 ||
    deps.initialSnapshot?.version === 3
      ? deps.initialSnapshot
      : undefined;
  let generated = Math.max(
    initialSnapshot?.generated ?? 0,
    definedPartIndices(content).filter((index) => {
      const part = content[index];
      return part?.type === ContentTypes.ACTIVITY_LABEL && part.activity_label_type === 'phase';
    }).length,
  );
  const emittedContentRanges = definedPartIndices(content).flatMap((index) => {
    const part = content[index];
    return part?.type === ContentTypes.ACTIVITY_LABEL &&
      part.activity_label_type === 'phase' &&
      typeof part.activity_start_index === 'number' &&
      typeof part.activity_end_index === 'number'
      ? [{ start: part.activity_start_index, end: part.activity_end_index }]
      : [];
  });
  const initiallyMaterializedToolIds = new Set(
    definedPartIndices(content).flatMap((index) => {
      const part = content[index];
      const id = part?.type === ContentTypes.TOOL_CALL ? part.tool_call?.id : undefined;
      return typeof id === 'string' ? [id] : [];
    }),
  );
  const restoreTrackedActivity = (activity: TrackedActivity): TrackedActivity => {
    const { unresolvedToolStartIndex, ...retainedActivity } = activity;
    const startIndex = findTrackedStart(content, activity);
    const bounded = activity.bounded === true;
    const toolCallIds = bounded
      ? (activity.toolCallIds?.slice(-MAX_RETAINED_TOOL_ENTRIES) ?? [])
      : (activity.toolCallIds ?? []);
    const hasUnresolvedTool = toolCallIds.some((id) => !initiallyMaterializedToolIds.has(id));
    return {
      ...retainedActivity,
      startIndex,
      ...(toolCallIds.length > 0 && { toolCallIds }),
      ...(bounded &&
        activity.thinkingExcerpts != null && {
          thinkingExcerpts: activity.thinkingExcerpts
            .slice(-MAX_RETAINED_TOOL_ENTRIES)
            .map((text) => text.slice(-REASONING_ANCHOR_CHARS)),
        }),
      ...(hasUnresolvedTool && {
        unresolvedToolStartIndex: Math.max(
          unresolvedToolStartIndex ?? activity.startIndex,
          startIndex,
        ),
      }),
    };
  };
  /** Versions 1 and 2 stored part of the total as bare scalars plus loose
   *  anchors. Rebuild that remainder as one positioned anchor so the boundary
   *  partition never has to reason about counts it cannot place. */
  const legacyAnchors = restoreLegacyOverflowAnchors(content, initialSnapshot);
  let activities: TrackedActivity[] = [
    ...(initialSnapshot?.activities ?? []).map(restoreTrackedActivity),
    ...legacyAnchors,
    ...(initialSnapshot?.overflowActivities ?? [])
      .slice(-MAX_OVERFLOW_ACTIVITY_ANCHORS)
      .map((activity) => restoreTrackedActivity({ ...activity, bounded: true })),
  ];
  const contributingAgentIds = new Set(initialSnapshot?.agentIds ?? []);
  let assistantContext: AssistantContextEntry[] = (initialSnapshot?.assistantContext ?? [])
    .slice(-MAX_CONTEXT_ITEMS)
    .map((entry) => (typeof entry === 'string' ? { text: entry } : { ...entry }));
  const pendingReasoning = new Map<string, { text: string; agentId?: string; startIndex?: number }>(
    (initialSnapshot?.pendingReasoning ?? []).map(({ key, text, agentId, startIndex }) => {
      const boundedText = text.slice(-MAX_EXCERPT_CHARS);
      const needle = boundedText.trim().slice(0, REASONING_ANCHOR_CHARS);
      const rebasedStartIndex = needle ? findReasoningStart(content, boundedText, startIndex) : -1;
      /** The anchor is a prefix, so two lanes can share it. Binding to the
       *  first match would replay a still-pending lane on the earlier side of
       *  a boundary and delete it; an ambiguous anchor is no anchor. */
      const matchingReasoningParts =
        needle.length > 0
          ? definedPartIndices(content).filter(
              (index) =>
                content[index]?.type === ContentTypes.THINK &&
                textValue(content[index]?.think).includes(needle),
            ).length
          : 0;
      const hasMaterializedReasoning =
        matchingReasoningParts === 1 &&
        content[rebasedStartIndex]?.type === ContentTypes.THINK &&
        textValue(content[rebasedStartIndex]?.think).includes(needle);
      return [
        key,
        {
          text: boundedText,
          ...(agentId != null && { agentId }),
          ...(hasMaterializedReasoning && { startIndex: rebasedStartIndex }),
        },
      ] as const;
    }),
  );
  const reasoningStepKeys = new Map<string, string>();
  const stepKinds = new Map<
    string,
    {
      kind: 'text' | 'think';
      phase?: AssistantTextPhase;
      captureContext?: boolean;
    }
  >();
  const textContextByStepId = new Map<string, AssistantContextEntry>();

  /** Keeps memory bounded without letting an activity lose its position:
   *  evidence is dropped first, then the oldest anchors fold forward into their
   *  successor, which is never earlier in the content and so cannot move a
   *  counted activity across a boundary it already preceded. */
  const boundActivities = () => {
    let evidenceBudget = MAX_RETAINED_ACTIVITIES;
    activities = activities.map((activity) => {
      if (activity.bounded === true) {
        return activity;
      }
      if (evidenceBudget > 0) {
        evidenceBudget -= 1;
        return activity;
      }
      return boundedAnchor(activity);
    });
    /** Merging the closest pair keeps the folded count on the side it was
     *  already on: a boundary can only fall at a content index, so merging
     *  neighbours that share one is exact, and otherwise the smallest gap is
     *  the least likely to have a boundary inside it. The survivor takes the
     *  earlier position so the pair's own phase still starts where its first
     *  activity did. */
    while (
      activities.filter((activity) => activity.bounded === true).length >
      MAX_OVERFLOW_ACTIVITY_ANCHORS
    ) {
      const anchorPositions = activities.flatMap((activity, position) =>
        activity.bounded === true ? [position] : [],
      );
      let mergeAt = 0;
      let bestGap = Number.POSITIVE_INFINITY;
      for (let pair = 1; pair < anchorPositions.length; pair += 1) {
        const earlier = activities[anchorPositions[pair - 1]];
        const later = activities[anchorPositions[pair]];
        const gap = Math.abs(later.startIndex - earlier.startIndex);
        if (gap < bestGap) {
          bestGap = gap;
          mergeAt = pair;
        }
      }
      const earlierPosition = anchorPositions[mergeAt - 1];
      const laterPosition = anchorPositions[mergeAt];
      const earlier = activities[earlierPosition];
      const later = activities[laterPosition];
      activities.splice(laterPosition, 1);
      activities[earlierPosition] = mergeAnchors(earlier, later);
    }
  };

  const applyRetained = (retained: PhasePartitionSide) => {
    const retainedStepKinds = new Map<
      string,
      { kind: 'text' | 'think'; phase?: AssistantTextPhase; captureContext?: boolean }
    >();
    for (const entry of retained.context) {
      const kind = entry.stepId == null ? undefined : stepKinds.get(entry.stepId);
      if (kind != null && entry.stepId != null) {
        retainedStepKinds.set(entry.stepId, kind);
      }
    }
    activities = retained.activities;
    assistantContext = retained.context;
    contributingAgentIds.clear();
    stepKinds.clear();
    textContextByStepId.clear();
    pendingReasoning.clear();
    reasoningStepKeys.clear();
    for (const activity of retained.activities) {
      if (activity.agentId != null) {
        contributingAgentIds.add(activity.agentId);
      }
    }
    for (const [stepId, kind] of retainedStepKinds) {
      stepKinds.set(stepId, kind);
    }
    for (const entry of retained.context) {
      if (entry.stepId != null) {
        textContextByStepId.set(entry.stepId, entry);
      }
    }
    for (const [key, reasoning] of retained.pendingReasoning) {
      pendingReasoning.set(key, reasoning);
    }
    for (const [stepId, key] of retained.reasoningStepKeys) {
      reasoningStepKeys.set(stepId, key);
    }
  };

  const trackActivity = (activity: TrackedActivity) => {
    if (activity.agentId != null) {
      contributingAgentIds.add(activity.agentId);
    }
    activities.push(activity);
    boundActivities();
  };

  const snapshot = (): ActivityPhaseSnapshot => ({
    version: 3,
    generated,
    activityCount: countActivities(activities),
    failedActivityCount: countFailedActivities(activities),
    partialActivityCount: countPartialActivities(activities),
    agentIds: [...contributingAgentIds],
    activities: activities.map((activity) => ({
      ...activity,
      ...(activity.entries != null && {
        entries: activity.entries.slice(0, MAX_RETAINED_TOOL_ENTRIES).map((entry) => ({
          ...entry,
          toolInput: stringifyActivityEvidence(entry.toolInput, charLimit),
          ...(entry.toolOutput != null && {
            toolOutput: stringifyActivityEvidence(entry.toolOutput, charLimit),
          }),
          ...(entry.error != null && { error: entry.error.slice(0, charLimit) }),
        })),
      }),
      ...(activity.thinkingExcerpts != null && {
        thinkingExcerpts: activity.thinkingExcerpts.map((text) => text.slice(-MAX_EXCERPT_CHARS)),
      }),
    })),
    assistantContext: assistantContext
      .slice(-MAX_CONTEXT_ITEMS)
      .map(({ text, activityPosition }) =>
        activityPosition == null ? text : { text, activityPosition },
      ),
    pendingReasoning: [...pendingReasoning].map(([key, reasoning]) => ({
      key,
      text: reasoning.text.slice(-MAX_EXCERPT_CHARS),
      ...(reasoning.agentId != null && { agentId: reasoning.agentId }),
      ...(reasoning.startIndex != null && { startIndex: reasoning.startIndex }),
    })),
  });

  const addPendingReasoning = (onlyKey?: string) => {
    let selected = [...pendingReasoning.entries()] as Array<
      readonly [string, { text: string; agentId?: string; startIndex?: number }]
    >;
    if (onlyKey != null) {
      const reasoning = pendingReasoning.get(onlyKey);
      selected = reasoning == null ? [] : [[onlyKey, reasoning] as const];
    }
    for (const [key, reasoning] of selected) {
      const text = reasoning.text.trim();
      if (text) {
        const parts = deps.getContentParts();
        trackActivity({
          thinkingExcerpts: [text.slice(0, MAX_EXCERPT_CHARS)],
          ...(reasoning.agentId != null && { agentId: reasoning.agentId }),
          status: 'success',
          startIndex: findReasoningStart(parts, text, reasoning.startIndex),
        });
      }
      pendingReasoning.delete(key);
    }
  };

  const resolveActivities = (snapshot: TrackedActivity[]): ActivityPhaseEntry[] => {
    const parts = deps.getContentParts();
    return snapshot
      .filter((activity) => activity.bounded !== true)
      .map(
        ({
          childLabelIndex,
          toolCallIds,
          startIndex: _startIndex,
          partitionStartIndex: _partitionStartIndex,
          unresolvedToolStartIndex: _unresolvedToolStartIndex,
          bounded: _bounded,
          mergedCount: _mergedCount,
          mergedFailedCount: _mergedFailedCount,
          mergedPartialCount: _mergedPartialCount,
          ...activity
        }) => {
          const matchesToolIds = (part: LooseContentPart | null | undefined): boolean => {
            if (
              part?.type !== ContentTypes.ACTIVITY_LABEL ||
              part.activity_label_type === 'phase'
            ) {
              return false;
            }
            if (toolCallIds == null || toolCallIds.length === 0) {
              return true;
            }
            const childIds = Array.isArray(part.tool_call_ids) ? part.tool_call_ids : [];
            return childIds.some((id) => typeof id === 'string' && toolCallIds.includes(id));
          };
          let child = childLabelIndex == null ? undefined : parts[childLabelIndex];
          if (!matchesToolIds(child) && toolCallIds != null && toolCallIds.length > 0) {
            child = definedPartIndices(parts)
              .map((index) => parts[index])
              .find(matchesToolIds);
          }
          if (!matchesToolIds(child)) {
            return activity;
          }
          const label =
            child?.pending !== true ? textValue(child?.[ContentTypes.ACTIVITY_LABEL]).trim() : '';
          return label ? { ...activity, label, entries: undefined } : activity;
        },
      );
  };

  /**
   * Splits every piece of tracked run state at one boundary. This is the only
   * place a phase decides what it owns: activities, their counts, assistant
   * context, and still-streaming reasoning all cross here together, so a new
   * field cannot be added on one side and forgotten on the other.
   *
   * `undefined` closes the whole run, which is the same split with a boundary
   * past every position.
   */
  const partitionAt = (requestedEndIndex: number | undefined): PhasePartition => {
    const currentParts = deps.getContentParts();
    /** Reasoning anchored before the boundary becomes an activity now; lanes
     *  still streaming past it stay live so their eventual tool batch remains
     *  one logical activity. */
    for (const [key, reasoning] of [...pendingReasoning]) {
      if (requestedEndIndex == null) {
        addPendingReasoning(key);
        continue;
      }
      const reasoningStart = findReasoningStart(currentParts, reasoning.text, reasoning.startIndex);
      if (reasoningStart < requestedEndIndex) {
        addPendingReasoning(key);
      }
    }
    const retainedPendingReasoning = [...pendingReasoning];
    const retainedReasoningKeys = new Set(retainedPendingReasoning.map(([key]) => key));
    const retainedReasoningStepKeys = [...reasoningStepKeys].filter(([, key]) =>
      retainedReasoningKeys.has(key),
    );
    /** Child-label and phase hooks run independently. A child label can claim
     *  its slot before the corresponding tool part reaches the shared content
     *  array, leaving the phase hook with a fallback start index. Re-anchor
     *  from stable tool ids when they are available at close. */
    /** The materialized tool indices answer every positional question a
     *  boundary asks — where the activity starts, which side it falls on, and
     *  where a retained straddling batch reanchors — so the shared content
     *  array is walked once per activity and the result carried through. */
    const resolved = activities.map((activity) => {
      const position = resolvePosition(currentParts, activity);
      const { unresolvedToolStartIndex, ...rest } = activity;
      return {
        activity: {
          ...rest,
          ...(position.awaitingTools &&
            unresolvedToolStartIndex != null && { unresolvedToolStartIndex }),
          startIndex: position.startsAt,
        },
        toolIndices: position.toolIndices,
        position,
      };
    });
    const closingActivities: TrackedActivity[] = [];
    const retainedActivities: TrackedActivity[] = [];
    for (const { activity, toolIndices, position } of resolved) {
      if (closesBeforeBoundary(position, requestedEndIndex)) {
        closingActivities.push(activity);
        continue;
      }
      const firstRetainedToolIndex =
        requestedEndIndex == null
          ? undefined
          : toolIndices.find((index) => index >= requestedEndIndex);
      retainedActivities.push(
        firstRetainedToolIndex != null
          ? {
              ...activity,
              startIndex: firstRetainedToolIndex,
              partitionStartIndex: firstRetainedToolIndex,
            }
          : activity,
      );
    }
    const closingCount = countActivities(closingActivities);
    const closingContext: AssistantContextEntry[] = [];
    const retainedContext: AssistantContextEntry[] = [];
    for (const entry of assistantContext) {
      const stepIndex = entry.stepId != null ? deps.getStepIndex?.(entry.stepId) : undefined;
      const located = entry.text.trim()
        ? locateTextEntry(currentParts, entry.text, stepIndex)
        : { index: stepIndex, authoritative: false };
      const entryIndex = located.index;
      /** Where the text actually rendered decides both directions, but only
       *  when that position is known to be this entry's. Registration order is
       *  the fallback: a parallel lane can register before the tool hooks that
       *  close the phase, or after work that already rendered ahead of it. */
      const retainsEntry = (boundary: number): boolean => {
        if (located.authoritative && entryIndex != null) {
          return entryIndex > boundary;
        }
        if (entry.activityPosition != null) {
          return entry.activityPosition > closingCount;
        }
        return entryIndex != null && entryIndex >= boundary;
      };
      const isRetained = requestedEndIndex != null && retainsEntry(requestedEndIndex);
      if (isRetained) {
        retainedContext.push({
          ...entry,
          ...(entry.activityPosition != null && {
            activityPosition: Math.max(0, entry.activityPosition - closingCount),
          }),
        });
        continue;
      }
      closingContext.push(entry);
    }
    return {
      closing: {
        activities: closingActivities,
        context: closingContext,
        pendingReasoning: [],
        reasoningStepKeys: [],
      },
      retained: {
        activities: retainedActivities,
        context: retainedContext,
        pendingReasoning: retainedPendingReasoning,
        reasoningStepKeys: retainedReasoningStepKeys,
      },
    };
  };

  const close = (closingTextPhase?: AssistantTextPhase, requestedEndIndex?: number) => {
    const currentParts = deps.getContentParts();
    const { closing, retained } = partitionAt(requestedEndIndex);
    const snapshot = closing.activities;
    const totalActivityCount = countActivities(snapshot);
    const failedCount = countFailedActivities(snapshot);
    const partialCount = countPartialActivities(snapshot);
    const agentIds = [
      ...new Set(
        snapshot.flatMap((activity) => [
          ...(activity.agentId != null ? [activity.agentId] : []),
          ...(activity.mergedAgentIds ?? []),
        ]),
      ),
    ];
    const closingContext = closing.context;
    applyRetained(retained);
    const contextSnapshot = closingContext
      .map(({ text }) => text)
      .filter((text) => text.trim().length > 0);
    /** Completion-finalized phases leave the final root text outside their
     *  UI bounds. Remove its matching retained excerpt from the label prompt
     *  as well, or the parent can paraphrase the answer it does not contain.
     *  Search from the tail because identical intermediate/final text should
     *  discard only the most recent capture. */
    if (requestedEndIndex != null) {
      const excludedText = textValue(currentParts[requestedEndIndex]?.text)
        .trim()
        .slice(-MAX_EXCERPT_CHARS);
      if (excludedText) {
        for (let position = contextSnapshot.length - 1; position >= 0; position -= 1) {
          if (contextSnapshot[position].trim() === excludedText) {
            contextSnapshot.splice(position, 1);
            break;
          }
        }
      }
    }
    if (generated >= maxPerRun || totalActivityCount < MIN_ACTIVITIES) {
      return;
    }

    generated += 1;
    const phaseIndex = generated - 1;
    /** The minimum-count guard above cannot pass on an empty partition, so
     *  every emitted phase has a positioned activity to anchor on. */
    let startIndex = Math.min(...snapshot.map((activity) => activity.startIndex));
    /** Pull leading commentary/reasoning into the parent card. A prior phase
     *  marker or steer is the only hard UI boundary; plain text can be
     *  intermediate context on providers that do not expose phase metadata. */
    const definedIndices = definedPartIndices(currentParts);
    let extendedStartIndex = 0;
    for (let position = definedIndices.length - 1; position >= 0; position -= 1) {
      const priorIndex = definedIndices[position];
      if (priorIndex >= startIndex) {
        continue;
      }
      const prior = currentParts[priorIndex];
      if (
        prior?.type === ContentTypes.STEER ||
        (prior?.type === ContentTypes.ACTIVITY_LABEL && prior.activity_label_type === 'phase') ||
        isSubstantialText(prior) ||
        (prior?.type === ContentTypes.TEXT &&
          prior.phase === 'final_answer' &&
          textValue(prior.text).trim().length > 0)
      ) {
        extendedStartIndex = priorIndex + 1;
        break;
      }
    }
    startIndex = extendedStartIndex;
    let phaseStatus: 'ok' | 'partial' | 'failed' = 'ok';
    if (failedCount === totalActivityCount) {
      phaseStatus = 'failed';
    } else if (failedCount > 0 || partialCount > 0) {
      phaseStatus = 'partial';
    }
    const index = deps.getContentParts().length;
    const endIndex = Math.max(startIndex, Math.min(index, requestedEndIndex ?? index));
    const part: LooseContentPart = {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: '',
      activity_label_type: 'phase',
      activity_start_index: startIndex,
      activity_end_index: endIndex,
      activity_count: totalActivityCount,
      ...(agentIds.length > 0 && { agent_ids: agentIds }),
      status: phaseStatus,
      pending: true,
    };
    deps.getContentParts().push(part);
    emittedContentRanges.push({ start: startIndex, end: endIndex });
    deps.bumpIndexOffset();
    void Promise.resolve(deps.emitLabelEvent(index, part)).catch(() => undefined);

    const task = (async () => {
      let generatedPhase: GeneratedActivityPhase = {};
      try {
        generatedPhase = await deps.generatePhase({
          activities: resolveActivities(snapshot),
          ...(contextSnapshot.length > 0 && { assistantContext: contextSnapshot }),
          ...(closingTextPhase != null && { closingTextPhase }),
          phaseIndex,
          totalActivityCount,
          status: phaseStatus === 'ok' ? 'completed' : phaseStatus,
          agentIds,
          charLimit,
          prompt: deps.prompt ?? ACTIVITY_PHASE_INSTRUCTION,
          signal: buildSignal(deps.abortSignal),
        });
      } catch {
        generatedPhase = {};
      }
      if (deps.isClosed?.() === true) {
        return;
      }
      const label = normalizeLabel(generatedPhase.label);
      const next: LooseContentPart = {
        ...part,
        [ContentTypes.ACTIVITY_LABEL]: label,
        pending: false,
      };
      try {
        await deps.emitLabelEvent(index, next);
        Object.assign(part, next);
      } catch {
        // A failed durable fill leaves the pending marker invisible and unbilled.
        return;
      }
      try {
        if (generatedPhase.collectUsage != null) {
          await generatedPhase.collectUsage(label || undefined);
        }
      } catch {
        // The committed UI projection must not regress when accounting fails.
      }
    })();
    deps.trackPendingFill(task);
  };

  const hook: HookCallback<'PostToolBatch'> = async (input: PostToolBatchInput) => {
    if (input.agentId != null || input.entries.length === 0 || deps.abortSignal?.aborted) {
      return {};
    }
    /** A top-level handoff is intentionally one logical phase activity. The
     *  child-label hook skips it because a transfer card cannot join a tool
     *  group; the parent phase can contain that card and should summarize the
     *  material agent transition. `input.agentId` above still excludes nested
     *  subagent internals. */
    const reasoningKey = input.executingAgentId ?? 'root';
    const reasoning = pendingReasoning.get(reasoningKey)?.text.trim();
    let trackedEntries = input.entries;
    let ids = new Set(trackedEntries.map((entry) => entry.toolUseId));
    const parts = deps.getContentParts();
    let childLabelIndex: number | undefined;
    let batchStartIndex: number | undefined;
    const indices = definedPartIndices(parts);
    for (let position = indices.length - 1; position >= 0; position -= 1) {
      const index = indices[position];
      const part = parts[index];
      if (
        part?.type === ContentTypes.TOOL_CALL &&
        typeof part.tool_call?.id === 'string' &&
        ids.has(part.tool_call.id)
      ) {
        batchStartIndex = index;
      }
      if (
        childLabelIndex == null &&
        part?.type === ContentTypes.ACTIVITY_LABEL &&
        part.activity_label_type !== 'phase'
      ) {
        const childIds = Array.isArray(part.tool_call_ids) ? part.tool_call_ids : [];
        if (childIds.some((id) => typeof id === 'string' && ids.has(id))) {
          childLabelIndex = index;
        }
      }
    }
    const coveredToolIds = new Set<string>();
    for (const index of definedPartIndices(parts)) {
      const part = parts[index];
      if (
        part?.type === ContentTypes.TOOL_CALL &&
        typeof part.tool_call?.id === 'string' &&
        ids.has(part.tool_call.id) &&
        emittedContentRanges.some(({ start, end }) => index >= start && index < end)
      ) {
        coveredToolIds.add(part.tool_call.id);
      }
    }
    if (coveredToolIds.size > 0) {
      trackedEntries = trackedEntries.filter((entry) => !coveredToolIds.has(entry.toolUseId));
      ids = new Set(trackedEntries.map((entry) => entry.toolUseId));
      /** The batch position was found before the covered calls were dropped.
       *  What remains is a different activity, and it may not have
       *  materialized at all, so re-derive its start from the retained ids. */
      batchStartIndex = undefined;
      for (const index of indices) {
        const part = parts[index];
        if (
          part?.type === ContentTypes.TOOL_CALL &&
          typeof part.tool_call?.id === 'string' &&
          ids.has(part.tool_call.id)
        ) {
          batchStartIndex = index;
          break;
        }
      }
    }
    if (trackedEntries.length === 0) {
      pendingReasoning.delete(reasoningKey);
      return {};
    }
    const entries = trackedEntries.map((entry: BatchEntry) => ({
      toolName: entry.toolName,
      toolInput: entry.toolInput,
      toolOutput: entry.toolOutput,
      error: entry.error,
      status: entry.status,
    }));
    const failures = entries.filter((entry) => entry.status === 'error').length;
    let activityStatus: TrackedActivity['status'] = 'success';
    if (failures === entries.length) {
      activityStatus = 'error';
    } else if (failures > 0) {
      activityStatus = 'partial';
    }
    const trackedStartIndex = batchStartIndex ?? Math.max(0, parts.length - 1);
    /** A batch can be tracked after its child-label slot is reserved but before
     *  its tool call reaches the shared array. Record where it started so a
     *  later boundary keeps it on its own side instead of reading "nothing
     *  materialized" as "happened earlier". */
    const awaitingMaterialization = batchStartIndex == null;
    trackActivity({
      entries,
      ...(reasoning ? { thinkingExcerpts: [reasoning.slice(0, MAX_EXCERPT_CHARS)] } : {}),
      ...(input.executingAgentId != null && { agentId: input.executingAgentId }),
      status: activityStatus,
      startIndex: trackedStartIndex,
      ...(awaitingMaterialization && { unresolvedToolStartIndex: trackedStartIndex }),
      toolCallIds: [...ids],
      ...(childLabelIndex != null && { childLabelIndex }),
    });
    pendingReasoning.delete(reasoningKey);
    return {};
  };

  const wrapHandlers = (
    handlers: Record<string, EventHandler> | undefined,
  ): Record<string, EventHandler> | undefined => {
    if (handlers == null) {
      return handlers;
    }
    const phaseHandlers = createAssistantPhaseStampingHandlers(handlers) ?? handlers;
    const wrapped = { ...phaseHandlers };
    const runStepHandler = phaseHandlers[GraphEvents.ON_RUN_STEP];
    if (runStepHandler != null) {
      wrapped[GraphEvents.ON_RUN_STEP] = {
        handle: (event, data, metadata, graph) => {
          const step = data as {
            id?: string;
            agentId?: string;
            groupId?: string | number;
            stepDetails?: {
              type?: string;
              message_creation?: { content_type?: string; phase?: string };
            };
          };
          if (step.stepDetails?.type === StepTypes.MESSAGE_CREATION && step.id) {
            const creation = step.stepDetails.message_creation;
            const kind = creation?.content_type === 'think' ? 'think' : 'text';
            const phase =
              creation?.phase === 'commentary' || creation?.phase === 'final_answer'
                ? creation.phase
                : undefined;
            if (kind === 'think') {
              stepKinds.set(step.id, { kind });
              const reasoningKey = step.agentId ?? 'root';
              reasoningStepKeys.set(step.id, reasoningKey);
              const result = runStepHandler.handle(event, data, metadata, graph);
              if (!pendingReasoning.has(reasoningKey)) {
                const startIndex = deps.getStepIndex?.(step.id);
                pendingReasoning.set(reasoningKey, {
                  text: '',
                  ...(step.agentId != null && { agentId: step.agentId }),
                  ...(startIndex != null && { startIndex }),
                });
              }
              return result;
            } else {
              const isRoot = step.groupId == null;
              if (phase !== 'commentary' && isRoot) {
                addPendingReasoning(step.agentId ?? 'root');
              }
              stepKinds.set(step.id, {
                kind,
                ...(phase != null && { phase }),
                captureContext: true,
              });
              const contextEntry: AssistantContextEntry = {
                stepId: step.id,
                text: '',
                activityPosition: countActivities(activities),
              };
              assistantContext.push(contextEntry);
              textContextByStepId.set(step.id, contextEntry);
              if (assistantContext.length > MAX_CONTEXT_ITEMS) {
                const removed = assistantContext.shift();
                if (removed?.stepId != null) {
                  textContextByStepId.delete(removed.stepId);
                }
              }
              const result = runStepHandler.handle(event, data, metadata, graph);
              if (phase === 'final_answer' && isRoot) {
                const boundaryIndex = deps.getStepIndex?.(step.id);
                if (
                  boundaryIndex != null &&
                  deps.getContentParts()[boundaryIndex]?.type === ContentTypes.TEXT
                ) {
                  close(phase, boundaryIndex);
                }
              }
              return result;
            }
          }
          return runStepHandler.handle(event, data, metadata, graph);
        },
      };
    }

    const messageHandler = phaseHandlers[GraphEvents.ON_MESSAGE_DELTA];
    if (messageHandler != null) {
      wrapped[GraphEvents.ON_MESSAGE_DELTA] = {
        handle: (event, data, metadata, graph) => {
          const id = (data as { id?: string }).id;
          const tracked = id ? stepKinds.get(id) : undefined;
          if (tracked?.kind === 'text' && tracked.captureContext === true) {
            const text = deltaText(data, 'text');
            const contextEntry = id ? textContextByStepId.get(id) : undefined;
            if (text && contextEntry != null) {
              contextEntry.text = `${contextEntry.text}${text}`.slice(-MAX_EXCERPT_CHARS);
            }
            const result = messageHandler.handle(event, data, metadata, graph);
            const boundaryIndex =
              id && contextEntry != null
                ? findTextBoundary(
                    deps.getContentParts(),
                    contextEntry.text,
                    deps.getStepIndex?.(id),
                  )
                : undefined;
            if (
              contextEntry != null &&
              contextEntry.text.trim().length > SUBSTANTIAL_TEXT_CHARS &&
              boundaryIndex != null
            ) {
              assistantContext = assistantContext.filter((entry) => entry !== contextEntry);
              textContextByStepId.delete(id ?? '');
              close(tracked.phase, boundaryIndex);
              stepKinds.delete(id ?? '');
            }
            return result;
          }
          return messageHandler.handle(event, data, metadata, graph);
        },
      };
    }

    const reasoningHandler = phaseHandlers[GraphEvents.ON_REASONING_DELTA];
    if (reasoningHandler != null) {
      wrapped[GraphEvents.ON_REASONING_DELTA] = {
        handle: (event, data, metadata, graph) => {
          const id = (data as { id?: string }).id;
          const reasoningKey = id ? reasoningStepKeys.get(id) : undefined;
          const reasoning = reasoningKey ? pendingReasoning.get(reasoningKey) : undefined;
          if (reasoning != null) {
            reasoning.text = `${reasoning.text}${deltaText(data, 'think')}`.slice(
              -MAX_EXCERPT_CHARS,
            );
          }
          return reasoningHandler.handle(event, data, metadata, graph);
        },
      };
    }
    return wrapped;
  };

  /**
   * The run's last visible text is its answer, so it stays outside the
   * collapsed parent whatever its length — a short "Done" must not disappear
   * into the activity card. Length only decides whether *intermediate* text
   * earns a boundary; semantic commentary is not an answer and stays inside.
   */
  const finalTextBoundary = (
    parts: ReadonlyArray<LooseContentPart | null | undefined>,
  ): number | undefined => {
    let candidate: number | undefined;
    for (const index of definedPartIndices(parts)) {
      const part = parts[index];
      if (part?.type === ContentTypes.TEXT && textValue(part.text).trim()) {
        candidate = index;
      }
    }
    if (candidate == null || parts[candidate]?.phase === 'commentary') {
      return undefined;
    }
    const boundary = candidate;
    if (
      activities.some(
        (activity) => !closesBeforeBoundary(resolvePosition(parts, activity), boundary),
      )
    ) {
      return undefined;
    }
    for (const reasoning of pendingReasoning.values()) {
      /** Empty reservations are not activities, but the SDK can still assign
       *  them a later sparse index; one must not pull the answer inside. */
      if (!reasoning.text.trim()) {
        continue;
      }
      if (findReasoningStart(parts, reasoning.text, reasoning.startIndex) >= boundary) {
        return undefined;
      }
    }
    return boundary;
  };

  const complete = () => {
    const parts = deps.getContentParts();
    /** A live substantial-text boundary normally closes its phase while
     *  streaming. Reconcile persisted content as a fallback for resume paths
     *  where the original delta crossed the boundary before this wiring was
     *  attached. */
    for (const index of definedPartIndices(parts)) {
      if (isSubstantialText(parts[index])) {
        const phase = parts[index]?.phase;
        close(phase === 'commentary' || phase === 'final_answer' ? phase : undefined, index);
      }
    }
    close(undefined, finalTextBoundary(deps.getContentParts()));
  };

  const drop = () => {
    applyRetained({ activities: [], context: [], pendingReasoning: [], reasoningStepKeys: [] });
  };

  return { hook, handlers: wrapHandlers, drop, complete, snapshot };
}

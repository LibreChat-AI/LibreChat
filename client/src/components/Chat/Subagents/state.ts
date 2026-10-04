import { useEffect } from 'react';
import { atomFamily } from 'jotai/utils';
import { atom, useAtomValue, useStore } from 'jotai';
import { ContentTypes, getToolTimingDurations } from 'librechat-data-provider';
import type {
  PartMetadata,
  SubagentControlReceipt,
  SubagentControlRequest,
  SubagentUpdatePhase,
  TMessageContentParts,
  SubagentUpdateEvent,
} from 'librechat-data-provider';
import type { Getter, PrimitiveAtom, WritableAtom } from 'jotai';
import type { SetStateAction } from 'react';
import type {
  SubagentAggregatorState,
  SubagentContentPart,
  SubagentTickerState,
} from '~/utils/subagentContent';
import {
  reconcileSubagentMessagePhases,
  reconcileSubagentToolTimings,
  foldSubagentEvent,
  foldSubagentEventIntoTicker,
  initSubagentAggregatorState,
  initSubagentTickerState,
} from '~/utils/subagentContent';

/**
 * Progress bucket captured per subagent tool call. Populated as
 * `ON_SUBAGENT_UPDATE` SSE events stream in from the backend. Keyed by the
 * parent invocation so provider-local tool call IDs cannot collide across
 * separate assistant messages.
 *
 * Both the panel content and the ticker are aggregated *incrementally*
 * into the atom as each envelope arrives — the atom never keeps the raw
 * event array. A long-running subagent can emit thousands of deltas
 * without retaining the raw event stream. The folded activity is also
 * capped by item count and encoded size to match the durable public view.
 */
export interface SubagentProgress {
  /** Child run id from the SDK — unique per spawn; one tool_call may only have one. */
  subagentRunId: string;
  /** `type` identifier from the SubagentConfig (e.g. 'self', 'researcher'). */
  subagentType: string;
  /** Child agent id (for avatar / name lookup in the ticker header). */
  subagentAgentId?: string;
  subagentKind?: SubagentUpdateEvent['subagentKind'];
  /**
   * Fully aggregated child content parts. Bounded by structure (text
   * runs + reasoning runs + tool calls), not by delta volume.
   */
  contentParts: SubagentContentPart[];
  /** Activity omitted by the bounded producer buffer during transport pressure. */
  droppedCount?: number;
  /** Marker receipts outlive content eviction, bounded like the delivery identity window. */
  omissionEventKeys?: string[];
  /** Cursor carried across `foldSubagentEvent` calls. */
  aggregatorState: SubagentAggregatorState;
  /** Ticker lines + live-cursor state, built incrementally. */
  tickerState: SubagentTickerState;
  /** Current lifecycle phase — drives the header "running" / "done" state. */
  status: SubagentUpdatePhase;
  /** Convenience: last event's `label` for quick ticker display. */
  latestLabel?: string;
  /** Bounded replay fence for events that overlap parent and detached SSE delivery. */
  recentEventKeys?: string[];
  /** Highest host sequence folded for this child run. Older overlap frames are ignored. */
  lastActivitySequence?: number;
  /** Earliest folded host sequence, used to distinguish backfill from a newer capped snapshot. */
  firstActivitySequence?: number;
  firstActivityEventId?: string;
  /** Disjoint folded ranges, never raw history. Adjacent ranges collapse into one. */
  replaySegments?: SubagentReplaySegment[];
  legacyReplayInvocations?: Array<{
    invocation: string;
    progress: Omit<SubagentProgress, 'legacyReplayInvocations'>;
  }>;
  /** Bounded future frames waiting for an earlier sequence at the parent/detached handoff. */
  pendingSequencedEvents?: SubagentUpdateEvent[];
  /** Earliest rejected host sequence. A detached reader requests replay after parent close. */
  activityReplayFrom?: number;
  activityReplayThrough?: number;
  /** Whether the folded events cover the run from its beginning or only the
   *  forward-only suffix observed after opening a detached task stream. */
  coverage?: 'complete' | 'suffix';
}

type SubagentReplaySegment = {
  from: number;
  through: number;
  progress: Omit<
    SubagentProgress,
    'replaySegments' | 'legacyReplayInvocations' | 'pendingSequencedEvents'
  >;
};

const MAX_RECENT_EVENT_KEYS = 256;
const MAX_PENDING_SEQUENCE_EVENTS = 100;
const MAX_PENDING_SEQUENCE_BYTES = 128 * 1024;
const MAX_LIVE_ACTIVITY_ITEMS = 100;
const MAX_LIVE_ACTIVITY_BYTES = 64 * 1024;
const MAX_SINGLE_ACTIVITY_ENCODED_BYTES = MAX_LIVE_ACTIVITY_BYTES - 2;
const MAX_SINGLE_ACTIVITY_TEXT_BYTES = 60 * 1024;
/** Substituted for reasoning text by pre-retention servers; current servers
 *  transport the bounded reasoning text itself. */
export const REDACTED_REASONING_MARKER = '…';

const encodedBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const truncateUtf8 = (value: string, maxBytes: number, keepTail = false): string => {
  if (new TextEncoder().encode(value).byteLength <= maxBytes) return value;
  const chars = [...value];
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = keepTail ? chars.slice(-mid).join('') : chars.slice(0, mid).join('');
    if (new TextEncoder().encode(candidate).byteLength <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return keepTail ? chars.slice(-low).join('') : chars.slice(0, low).join('');
};

const fitStringField = <T>(
  value: string,
  candidate: (bounded: string) => T,
  maxBytes: number,
  keepTail = false,
): T => {
  const chars = [...value];
  let low = 0;
  let high = chars.length;
  let result = candidate('');
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const bounded = keepTail ? chars.slice(-mid).join('') : chars.slice(0, mid).join('');
    const next = candidate(bounded);
    if (encodedBytes(next) <= maxBytes) {
      low = mid;
      result = next;
    } else {
      high = mid - 1;
    }
  }
  return result;
};

const boundSingletonPart = (part: SubagentContentPart): SubagentContentPart => {
  if (part.type === ContentTypes.TEXT) {
    const rawBounded = truncateUtf8(part.text, MAX_SINGLE_ACTIVITY_TEXT_BYTES, true);
    return fitStringField(
      rawBounded,
      (text) => ({ ...part, text }),
      MAX_SINGLE_ACTIVITY_ENCODED_BYTES,
      true,
    );
  }
  if (part.type === ContentTypes.THINK) {
    const rawBounded = truncateUtf8(part.think, MAX_SINGLE_ACTIVITY_TEXT_BYTES, true);
    return fitStringField(
      rawBounded,
      (think) => ({ ...part, think }),
      MAX_SINGLE_ACTIVITY_ENCODED_BYTES,
      true,
    );
  }

  let bounded: SubagentContentPart = {
    ...part,
    tool_call: {
      ...part.tool_call,
      args: truncateUtf8(part.tool_call.args, 24 * 1024),
      ...(part.tool_call.output == null
        ? {}
        : { output: truncateUtf8(part.tool_call.output, 24 * 1024, true) }),
    },
  };
  if (encodedBytes(bounded) <= MAX_SINGLE_ACTIVITY_ENCODED_BYTES) return bounded;

  const fitToolField = (field: 'output' | 'args' | 'name' | 'id' | 'type', keepTail = false) => {
    if (bounded.type !== ContentTypes.TOOL_CALL) return;
    const current = bounded;
    const value = current.tool_call[field];
    if (typeof value !== 'string') return;
    bounded = fitStringField(
      value,
      (nextValue) => ({
        ...current,
        tool_call: { ...current.tool_call, [field]: nextValue },
      }),
      MAX_SINGLE_ACTIVITY_ENCODED_BYTES,
      keepTail,
    ) as SubagentContentPart;
  };
  fitToolField('output', true);
  if (encodedBytes(bounded) > MAX_SINGLE_ACTIVITY_ENCODED_BYTES) fitToolField('args');
  if (encodedBytes(bounded) > MAX_SINGLE_ACTIVITY_ENCODED_BYTES) fitToolField('name');
  if (encodedBytes(bounded) > MAX_SINGLE_ACTIVITY_ENCODED_BYTES) fitToolField('id');
  if (encodedBytes(bounded) > MAX_SINGLE_ACTIVITY_ENCODED_BYTES) fitToolField('type');
  return bounded;
};

const boundContentParts = (
  parts: SubagentContentPart[],
  state: SubagentAggregatorState,
): { parts: SubagentContentPart[]; state: SubagentAggregatorState } => {
  const start = Math.max(0, parts.length - MAX_LIVE_ACTIVITY_ITEMS);
  let offset = parts.length;
  let totalBytes = 2;
  let bounded: SubagentContentPart[] = [];
  for (let index = parts.length - 1; index >= start; index -= 1) {
    const partBytes = encodedBytes(parts[index]);
    const separatorBytes = bounded.length === 0 ? 0 : 1;
    if (totalBytes + separatorBytes + partBytes > MAX_LIVE_ACTIVITY_BYTES) {
      if (bounded.length === 0) {
        bounded = [boundSingletonPart(parts[index])];
        offset = index;
      }
      break;
    }
    bounded.unshift(parts[index]);
    offset = index;
    totalBytes += separatorBytes + partBytes;
  }
  if (encodedBytes(bounded) > MAX_LIVE_ACTIVITY_BYTES) {
    bounded = [];
    offset = parts.length;
  }
  const rebase = (index: number | null): number | null =>
    index != null && index >= offset && index - offset < bounded.length ? index - offset : null;
  const toolCallIndexById = Object.fromEntries(
    bounded.flatMap((part, index) =>
      part.type === ContentTypes.TOOL_CALL ? [[part.tool_call.id, index]] : [],
    ),
  );
  return {
    parts: bounded,
    state: {
      ...state,
      openTextIdx: rebase(state.openTextIdx),
      openThinkIdx: rebase(state.openThinkIdx),
      toolCallIndexById,
    },
  };
};

const boundTickerState = (state: SubagentTickerState): SubagentTickerState => {
  const start = Math.max(0, state.lines.length - MAX_LIVE_ACTIVITY_ITEMS);
  let offset = state.lines.length;
  let totalBytes = 2;
  const lines = [] as SubagentTickerState['lines'];
  for (let index = state.lines.length - 1; index >= start; index -= 1) {
    const lineBytes = encodedBytes(state.lines[index]);
    const separatorBytes = lines.length === 0 ? 0 : 1;
    if (totalBytes + separatorBytes + lineBytes > MAX_LIVE_ACTIVITY_BYTES) break;
    lines.unshift(state.lines[index]);
    offset = index;
    totalBytes += separatorBytes + lineBytes;
  }
  const rebase = (index: number | null): number | null =>
    index != null && index >= offset ? index - offset : null;
  return {
    ...state,
    lines,
    textLineIdx: rebase(state.textLineIdx),
    thinkLineIdx: rebase(state.thinkLineIdx),
  };
};

const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const eventKey = (event: SubagentUpdateEvent): string | undefined => {
  const activityEventId = event.activityEventId?.trim();
  if (!activityEventId) return undefined;
  return hashString(`${event.subagentRunId}\u0000${activityEventId}`);
};

export type SubagentContentPreview = {
  revision: string;
  stepId?: string;
  agentId?: string;
};

/** One child invocation selected for the shared read-only activity panel. */
export type ActiveSubagentPanel = {
  host: 'conversation' | 'share';
  subagentIdentity?: PartMetadata['subagentIdentity'];
  shareId?: string;
  parentConversationId: string;
  parentMessageId: string;
  toolCallId: string;
  partIndex: number;
  subagentType: string;
  prompt?: string;
  legacyOutput?: string | null;
  persistedContent?: TMessageContentParts[];
  /** The tool call came from the server as a preview: its transcript, output or arguments are
   *  shortened or absent, so the panel loads the stored part before rendering activity. Carries
   *  what identifies the stored part and the preview's revision. */
  contentPreview?: SubagentContentPreview;
  initialProgress: number;
  isSubmitting: boolean;
  runStepStatus?: PartMetadata['runStepStatus'];
  durable?: {
    threadId: string;
    taskId: string;
  };
  event?: {
    actorId: string;
    /** Task-specific live activity identity; the actor thread is reused across turns. */
    progressKey: string;
    /** Message anchors merged into the same parent-owned activity group. */
    siblingParentMessageIds?: string[];
    /** The selection deliberately targets a historical task; the panel must
     *  not snap it forward when the actor thread receives a newer delivery. */
    pinnedTask?: boolean;
  };
};

export const activeSubagentPanel = atom<ActiveSubagentPanel | null>(null);

export type SubagentControlUiReceipt = Omit<SubagentControlReceipt, 'status'> & {
  status: SubagentControlReceipt['status'] | 'submitted';
};

export type SubagentControlUiState = {
  receipt: SubagentControlUiReceipt;
  /** Present only while the same invocation must be retried to resolve an
   * ambiguous delivery. It is never replaced with a fresh invocation id. */
  retry?: SubagentControlRequest;
};

export const subagentControlStateKey = (
  parentConversationId: string,
  threadId: string,
  taskId: string,
): string => `${parentConversationId}\u0000${threadId}\u0000${taskId}`;

const SUBAGENT_CONTROL_STORAGE_PREFIX = 'librechat.subagent-control:';
const CONTROL_ACTIONS = new Set(['steer', 'queue', 'interrupt', 'cancel', 'cancel_message']);
const storedControlState = (value: unknown): SubagentControlUiState | null => {
  if (value == null || typeof value !== 'object') return null;
  const candidate = value as Partial<SubagentControlUiState>;
  const receipt = candidate.receipt as Partial<SubagentControlUiReceipt> | undefined;
  const retry = candidate.retry as Partial<SubagentControlRequest> | undefined;
  if (
    receipt == null ||
    typeof receipt.invocationId !== 'string' ||
    !CONTROL_ACTIONS.has(receipt.action ?? '') ||
    (receipt.status !== 'submitted' && receipt.status !== 'failed') ||
    typeof receipt.createdAt !== 'string' ||
    typeof receipt.updatedAt !== 'string' ||
    retry == null ||
    typeof retry.taskId !== 'string' ||
    retry.taskId === '' ||
    retry.invocationId !== receipt.invocationId ||
    retry.action !== receipt.action ||
    !CONTROL_ACTIONS.has(retry.action ?? '')
  ) {
    return null;
  }
  const action = retry.action as SubagentControlRequest['action'];
  if (
    (action === 'cancel' && (retry.message != null || retry.controlId != null)) ||
    (action === 'cancel_message' &&
      (typeof retry.controlId !== 'string' || retry.controlId === '' || retry.message != null)) ||
    (action !== 'cancel' &&
      action !== 'cancel_message' &&
      (typeof retry.message !== 'string' || retry.message.trim() === '' || retry.controlId != null))
  ) {
    return null;
  }
  const now = new Date().toISOString();
  const sanitizedRetry = {
    taskId: retry.taskId,
    invocationId: retry.invocationId,
    action,
    ...(action === 'cancel_message' ? { controlId: retry.controlId as string } : {}),
    ...(action !== 'cancel' && action !== 'cancel_message'
      ? { message: retry.message as string }
      : {}),
  } as SubagentControlRequest;
  return {
    receipt: {
      invocationId: receipt.invocationId,
      action,
      status: 'failed',
      createdAt: receipt.createdAt,
      updatedAt: now,
      ...(action === 'cancel_message' ? { controlId: retry.controlId as string } : {}),
      ...(action !== 'cancel' && action !== 'cancel_message'
        ? { message: retry.message as string }
        : {}),
      reason: 'owner_unavailable',
    },
    retry: sanitizedRetry,
  };
};

const controlStorageKey = (identity: string): string =>
  `${SUBAGENT_CONTROL_STORAGE_PREFIX}${encodeURIComponent(identity)}`;

const restoreControlState = (identity: string): SubagentControlUiState | null => {
  if (typeof window === 'undefined') return null;
  const storageKey = controlStorageKey(identity);
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (raw == null) return null;
    const restored = storedControlState(JSON.parse(raw));
    if (restored == null) window.sessionStorage.removeItem(storageKey);
    return restored;
  } catch {
    try {
      window.sessionStorage.removeItem(storageKey);
    } catch {
      // Some privacy modes deny session storage entirely.
    }
    return null;
  }
};

const persistControlState = (identity: string, next: SubagentControlUiState | null): void => {
  if (typeof window === 'undefined') return;
  const storageKey = controlStorageKey(identity);
  try {
    /** Only an ambiguous retry has to outlive the tab's memory; anything else
     *  is reconstructed from the durable receipts on the next read. */
    if (next?.retry == null) window.sessionStorage.removeItem(storageKey);
    else window.sessionStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // Storage is best-effort; the in-memory receipt still protects this mounted session.
  }
};

/** Parent-owned control state survives closing the activity panel or selecting
 * another child. Ambiguous retries also survive a full page reload in this tab;
 * durable receipts clear both copies after authoritative reconciliation. */
const UNWRITTEN = Symbol('unwritten');

export const subagentControlStateByTask = atomFamily<
  string,
  WritableAtom<SubagentControlUiState | null, [SetStateAction<SubagentControlUiState | null>], void>
>((identity: string) => {
  /** Restored per store rather than per family member: a member is created
   *  once for the tab, and a reload has to see what the last one persisted. */
  const restored = atom(() => restoreControlState(identity));
  const held: PrimitiveAtom<SubagentControlUiState | null | typeof UNWRITTEN> = atom(
    UNWRITTEN as SubagentControlUiState | null | typeof UNWRITTEN,
  );
  const read = (get: Getter): SubagentControlUiState | null => {
    const current = get(held);
    return current === UNWRITTEN ? get(restored) : current;
  };
  return atom(read, (get, set, update: SetStateAction<SubagentControlUiState | null>) => {
    const next =
      typeof update === 'function'
        ? (update as (previous: SubagentControlUiState | null) => SubagentControlUiState | null)(
            read(get),
          )
        : update;
    set(held, next);
    persistControlState(identity, next);
  });
});

/** Stable identity for one subagent invocation in the parent conversation. */
export const subagentProgressKey = (
  parentMessageId: string,
  toolCallId: string,
  partIndex: number,
) => `${parentMessageId}\u0000${toolCallId}\u0000${partIndex}`;

/** Progress state keyed by one concrete tool-call content-part occurrence. */
export const subagentProgressByToolCallId = atomFamily((_key: string) =>
  atom<SubagentProgress | null>(null),
);

/** Parent delivery remains authoritative until its ordered SSE close boundary. */
export const subagentParentStreamOpenByToolCallId = atomFamily((_key: string) => atom(false));

/**
 * Invocation atoms populated by either the parent generation stream or the selected detached
 * task stream. The conversation host drains this registry on navigation so both transports share
 * one cleanup boundary instead of leaking detached-only atom-family members for the app lifetime.
 * Members a card created by reading are not enrolled here — they are freed at that card's unmount
 * instead, since the routes that render one do not all own this drain.
 */
const registeredSubagentProgressKeys = new Set<string>();

export function registerSubagentProgressKey(key: string): void {
  registeredSubagentProgressKeys.add(key);
}

export function takeRegisteredSubagentProgressKeys(): string[] {
  const keys = [...registeredSubagentProgressKeys];
  registeredSubagentProgressKeys.clear();
  return keys;
}

export function listRegisteredSubagentProgressKeys(): string[] {
  return [...registeredSubagentProgressKeys];
}

/**
 * Frees the family members held for one invocation. An `atomFamily` caches a
 * member per key for the life of the tab, and every invocation key is unique,
 * so the drain boundary has to release them or a long session accumulates two
 * atom configurations per subagent call it ever saw. Callers clear the values
 * first: `remove` drops the cached member without telling anything subscribed
 * to it.
 */
export function removeSubagentProgressAtoms(invocationKey: string): void {
  subagentProgressByToolCallId.remove(invocationKey);
  subagentParentStreamOpenByToolCallId.remove(invocationKey);
}

/** How many mounted readers hold each invocation's member. Removing one while
 *  a reader still has it is not merely wasteful: that reader stays subscribed
 *  to the removed atom, the next write lands on the member the family makes to
 *  replace it, and the two never meet again. */
const subagentProgressReaders = new Map<string, number>();

/**
 * Reads one invocation's live progress, and frees the family member once the
 * last reader lets go and nothing else has a claim on it.
 *
 * The read itself creates the member, and only the chat route owns the stream
 * drain — a card rendered by a search result or by a conversation that finished
 * streaming long ago would otherwise hold one for the life of the tab. Three
 * things have to be true before one is freed: no reader is left, no stream
 * registered the key (that member belongs to the drain), and it holds no folded
 * activity (that member is the record of what the child did).
 */
export function useSubagentProgress(invocationKey: string): SubagentProgress | null {
  const store = useStore();
  useEffect(() => {
    subagentProgressReaders.set(
      invocationKey,
      (subagentProgressReaders.get(invocationKey) ?? 0) + 1,
    );
    return () => {
      const remaining = (subagentProgressReaders.get(invocationKey) ?? 1) - 1;
      if (remaining > 0) {
        subagentProgressReaders.set(invocationKey, remaining);
        return;
      }
      subagentProgressReaders.delete(invocationKey);
      if (registeredSubagentProgressKeys.has(invocationKey)) return;
      if (store.get(subagentProgressByToolCallId(invocationKey)) != null) return;
      removeSubagentProgressAtoms(invocationKey);
    };
  }, [invocationKey, store]);
  return useAtomValue(subagentProgressByToolCallId(invocationKey));
}

const validActivitySequence = (value: number | undefined): value is number =>
  Number.isSafeInteger(value) && value != null && value >= 0;

function acceptedOmissions(
  previous: SubagentProgress | null,
  events: SubagentUpdateEvent[],
): Pick<SubagentProgress, 'droppedCount' | 'omissionEventKeys'> {
  let droppedCount = previous?.droppedCount ?? 0;
  let keys = previous?.omissionEventKeys;
  let seen: Set<string> | undefined;
  for (const event of events) {
    const count = event.activityDroppedCount;
    if (!Number.isSafeInteger(count) || (count ?? 0) <= 0) continue;
    const key = eventKey(event);
    if (key != null) {
      seen ??= new Set(keys);
      if (seen.has(key)) continue;
    }
    droppedCount += count!;
    if (key != null) {
      seen!.add(key);
      if (keys == null || keys === previous?.omissionEventKeys) keys = [...(keys ?? [])];
      keys.push(key);
    }
  }
  return {
    droppedCount,
    omissionEventKeys:
      keys != null && keys.length > MAX_RECENT_EVENT_KEYS
        ? keys.slice(-MAX_RECENT_EVENT_KEYS)
        : keys,
  };
}

const foldAcceptedSubagentEvents = (
  previous: SubagentProgress | null,
  events: SubagentUpdateEvent[],
  source: 'parent' | 'detached',
  pendingSequencedEvents: SubagentUpdateEvent[],
  projectingLegacy = false,
): SubagentProgress | null => {
  if (events.length === 0) {
    if (previous == null) {
      const first = pendingSequencedEvents[0];
      if (first == null) return null;
      return {
        subagentRunId: first.subagentRunId,
        subagentType: first.subagentType,
        subagentAgentId: first.subagentAgentId,
        subagentKind: first.subagentKind,
        contentParts: [],
        aggregatorState: initSubagentAggregatorState(),
        tickerState: initSubagentTickerState(),
        status: first.phase,
        recentEventKeys: [],
        pendingSequencedEvents,
        coverage: source === 'detached' ? 'suffix' : 'complete',
      };
    }
    if (
      (previous.pendingSequencedEvents == null && pendingSequencedEvents.length === 0) ||
      (previous.pendingSequencedEvents?.length === pendingSequencedEvents.length &&
        previous.pendingSequencedEvents.every(
          (event, index) => event === pendingSequencedEvents[index],
        ))
    ) {
      return previous;
    }
    return {
      ...previous,
      ...(pendingSequencedEvents.length === 0 ? {} : { pendingSequencedEvents }),
    };
  }
  if (
    !projectingLegacy &&
    events.every((event) => event.activitySequence == null && eventLegacyOrdinal(event) != null)
  )
    return foldLegacyInvocations(previous, events, pendingSequencedEvents);
  const firstSequence = events[0].activitySequence;
  const priorSequence = previous?.lastActivitySequence;
  const hasGap =
    validActivitySequence(firstSequence) &&
    validActivitySequence(priorSequence) &&
    firstSequence > priorSequence + 1;
  const batchGap = events.some(
    (event, index) =>
      index > 0 &&
      validActivitySequence(event.activitySequence) &&
      validActivitySequence(events[index - 1].activitySequence) &&
      event.activitySequence !== events[index - 1].activitySequence! + 1,
  );
  if (previous?.replaySegments != null || hasGap || batchGap)
    return foldReplaySegments(previous, events, pendingSequencedEvents);
  const recentEventKeys = [...(previous?.recentEventKeys ?? [])];
  for (const event of events) {
    const key = eventKey(event);
    if (key != null) recentEventKeys.push(key);
  }
  const boundedEventKeys = recentEventKeys.slice(-MAX_RECENT_EVENT_KEYS);
  let contentParts = previous?.contentParts ?? [];
  let aggregatorState = previous?.aggregatorState ?? initSubagentAggregatorState();
  let tickerState = previous?.tickerState ?? initSubagentTickerState();
  let subagentKind = previous?.subagentKind;
  const omissions = acceptedOmissions(previous, events);
  for (const event of events) {
    subagentKind = event.subagentKind ?? subagentKind;
    const foldEvent =
      event.phase === 'reasoning_delta' &&
      event.data == null &&
      aggregatorState.openThinkIdx == null
        ? {
            ...event,
            data: {
              delta: {
                content: [{ type: ContentTypes.THINK, think: REDACTED_REASONING_MARKER }],
              },
            },
          }
        : event;
    ({ parts: contentParts, state: aggregatorState } = foldSubagentEvent(
      contentParts,
      aggregatorState,
      foldEvent,
    ));
    tickerState = foldSubagentEventIntoTicker(tickerState, foldEvent);
  }
  ({ parts: contentParts, state: aggregatorState } = boundContentParts(
    contentParts,
    aggregatorState,
  ));
  tickerState = boundTickerState(tickerState);
  const last = events[events.length - 1];
  const lastActivitySequence = [...events]
    .reverse()
    .map((event) => event.activitySequence)
    .find(validActivitySequence);
  const effectiveActivitySequence = lastActivitySequence ?? previous?.lastActivitySequence;
  const acceptedRunStart = events.some((event) => event.activitySequence === 0);
  return {
    subagentRunId: last.subagentRunId,
    subagentType: last.subagentType,
    subagentAgentId: last.subagentAgentId ?? previous?.subagentAgentId,
    subagentKind,
    contentParts,
    aggregatorState,
    tickerState,
    activityReplayFrom: previous?.activityReplayFrom,
    activityReplayThrough: previous?.activityReplayThrough,
    legacyReplayInvocations: previous?.legacyReplayInvocations,
    firstActivityEventId: previous?.firstActivityEventId ?? events[0].activityEventId,
    firstActivitySequence:
      previous?.subagentRunId === last.subagentRunId
        ? (previous.firstActivitySequence ??
          events.find((event) => validActivitySequence(event.activitySequence))?.activitySequence)
        : events.find((event) => validActivitySequence(event.activitySequence))?.activitySequence,
    status: last.phase,
    ...omissions,
    latestLabel: last.label ?? previous?.latestLabel,
    recentEventKeys: boundedEventKeys,
    ...(effectiveActivitySequence == null
      ? {}
      : { lastActivitySequence: effectiveActivitySequence }),
    ...(pendingSequencedEvents.length === 0 ? {} : { pendingSequencedEvents }),
    coverage: acceptedRunStart
      ? 'complete'
      : (previous?.coverage ?? (source === 'detached' ? 'suffix' : 'complete')),
  };
};

/** Parent SSE close is an ordering fence: all its earlier frames have already been handled. */
export function closeParentSubagentProgress(
  previous: SubagentProgress | null,
): SubagentProgress | null {
  if (previous?.activityReplayFrom != null) {
    return previous;
  }
  if (previous?.pendingSequencedEvents == null || previous.pendingSequencedEvents.length === 0) {
    return previous;
  }
  const pending = [...previous.pendingSequencedEvents].sort(
    (left, right) => (left.activitySequence ?? 0) - (right.activitySequence ?? 0),
  );
  return foldAcceptedSubagentEvents(
    { ...previous, pendingSequencedEvents: undefined },
    pending,
    previous.coverage === 'suffix' ? 'detached' : 'parent',
    [],
  );
}

/** Shared reducer for foreground chat SSE and task-scoped detached activity SSE. */
export function reduceSubagentProgress(
  previous: SubagentProgress | null,
  events: SubagentUpdateEvent[],
  source: 'parent' | 'detached' = 'parent',
  waitForEarlierSequences = source === 'parent',
): SubagentProgress | null {
  if (events.length === 0) return previous;
  const repair =
    previous?.replaySegments != null
      ? events.filter(
          (event) =>
            validActivitySequence(event.activitySequence) &&
            event.activitySequence <= (previous.lastActivitySequence ?? -1) &&
            !previous.replaySegments!.some(
              (segment) =>
                event.activitySequence! >= segment.from &&
                event.activitySequence! <= segment.through,
            ),
        )
      : [];
  if (repair.length > 0) {
    const repaired = foldReplaySegments(previous, repair, previous!.pendingSequencedEvents ?? []);
    const remaining = events.filter((event) => !repair.includes(event));
    return remaining.length === 0
      ? releaseRecoveredActivity(repaired)
      : reduceSubagentProgress(repaired, remaining, source, waitForEarlierSequences);
  }
  const recentEventKeys = [...(previous?.recentEventKeys ?? [])];
  const seen = new Set(recentEventKeys);
  const sequenced = events.every(
    (event) => Number.isSafeInteger(event.activitySequence) && (event.activitySequence ?? -1) >= 0,
  );
  const orderedEvents = sequenced
    ? [...events].sort((left, right) =>
        (left.activitySequence ?? 0) === (right.activitySequence ?? 0)
          ? 0
          : (left.activitySequence ?? 0) - (right.activitySequence ?? 0),
      )
    : events;
  const sameRun = previous?.subagentRunId === orderedEvents[0]?.subagentRunId;
  const lastActivitySequence = sameRun ? previous.lastActivitySequence : undefined;
  const pending = sameRun ? [...(previous.pendingSequencedEvents ?? [])] : [];
  const pendingSequences = new Set(
    pending.map((event) => event.activitySequence).filter(validActivitySequence),
  );
  const directEvents: SubagentUpdateEvent[] = [];
  let replayFrom = sameRun ? previous?.activityReplayFrom : undefined;
  let replayThrough = sameRun ? previous?.activityReplayThrough : undefined;
  let expected = lastActivitySequence == null ? 0 : lastActivitySequence + 1;
  if (!waitForEarlierSequences && lastActivitySequence == null) {
    const firstSequence = [...pending, ...orderedEvents]
      .map((event) => event.activitySequence)
      .filter(validActivitySequence)
      .sort((left, right) => left - right)[0];
    if (firstSequence != null) expected = firstSequence;
  }

  const drainPending = () => {
    pending.sort((left, right) => (left.activitySequence ?? 0) - (right.activitySequence ?? 0));
    while (pending[0]?.activitySequence === expected) {
      const event = pending.shift();
      if (event == null) break;
      pendingSequences.delete(expected);
      directEvents.push(event);
      expected += 1;
    }
  };

  drainPending();
  for (const event of orderedEvents) {
    const sequence = event.activitySequence;
    const key = eventKey(event);
    if (key != null && seen.has(key)) continue;
    if (validActivitySequence(sequence)) {
      if (sequence < expected) continue;
      if (pendingSequences.has(sequence)) {
        if ((event.activityDroppedCount ?? 0) > 0) {
          const index = pending.findIndex((entry) => entry.activitySequence === sequence);
          if (index >= 0 && (pending[index].activityDroppedCount ?? 0) === 0)
            pending[index] = event;
        }
        continue;
      }
      if (sequence === expected) {
        directEvents.push(event);
        expected += 1;
        drainPending();
      } else if (
        pending.length < MAX_PENDING_SEQUENCE_EVENTS &&
        encodedBytes([...pending, event]) <= MAX_PENDING_SEQUENCE_BYTES
      ) {
        pending.push(event);
        pendingSequences.add(sequence);
      } else {
        replayFrom = Math.min(replayFrom ?? sequence, sequence);
        replayThrough = Math.max(replayThrough ?? sequence, sequence);
      }
    } else {
      if (key != null) seen.add(key);
      directEvents.push(event);
    }
  }
  drainPending();
  while (!waitForEarlierSequences && pending[0]?.activitySequence != null) {
    expected = pending[0].activitySequence;
    drainPending();
  }
  const progress = foldAcceptedSubagentEvents(previous, directEvents, source, pending);
  if (progress == null) return progress;
  if (
    progress.activityReplayFrom === replayFrom &&
    progress.activityReplayThrough === replayThrough
  )
    return releaseRecoveredActivity(progress);
  return releaseRecoveredActivity({
    ...progress,
    activityReplayFrom: replayFrom,
    activityReplayThrough: replayThrough,
  });
}

/** Prefix events are new coverage, not a replacement for newer foreground parts.
 * Reconcile bounded projections instead of retaining another raw event history. */
function prependSubagentReplay(
  previous: SubagentProgress,
  prefix: SubagentProgress,
  inheritMessagePhases = true,
): SubagentProgress {
  let parts = prefix.contentParts;
  let state = inheritMessagePhases
    ? prefix.aggregatorState
    : { ...prefix.aggregatorState, messagePhaseByStepId: {}, idlessTextPhase: undefined };
  const indices = new Map<number, number>();
  for (let index = 0; index < previous.contentParts.length; index++) {
    const part = previous.contentParts[index];
    const event: SubagentUpdateEvent = {
      runId: '',
      subagentRunId: previous.subagentRunId,
      subagentType: previous.subagentType,
      subagentAgentId: previous.subagentAgentId ?? '',
      phase: 'message_delta',
      timestamp: '',
    };
    if (part.type === ContentTypes.TEXT) {
      event.phase = 'message_delta';
      event.data = {
        ...(part.stepId == null ? {} : { id: part.stepId }),
        delta: { content: [part] },
      };
    } else if (part.type === ContentTypes.THINK) {
      event.phase = 'reasoning_delta';
      event.data = { delta: { content: [part] } };
    } else {
      event.phase = 'run_step';
      event.data = {
        id: part.tool_call.stepId,
        stepDetails: { type: 'tool_calls', tool_calls: [part.tool_call] },
      };
    }
    ({ parts, state } = foldSubagentEvent(parts, state, event));
    let target: number;
    if (part.type === ContentTypes.TOOL_CALL) {
      target = state.toolCallIndexById[part.tool_call.id];
      const prefixTool = parts[target];
      parts = parts.slice();
      const sameStep =
        prefixTool.type === ContentTypes.TOOL_CALL &&
        prefixTool.tool_call.stepId != null &&
        prefixTool.tool_call.stepId === part.tool_call.stepId;
      const tool = {
        ...(prefixTool.type === ContentTypes.TOOL_CALL ? prefixTool.tool_call : {}),
        ...part.tool_call,
        ...(part.tool_call.argsUnavailable &&
        prefixTool.type === ContentTypes.TOOL_CALL &&
        !prefixTool.tool_call.argsUnavailable
          ? { args: prefixTool.tool_call.args, argsUnavailable: undefined }
          : {}),
        ...(part.tool_call.nameUnavailable &&
        prefixTool.type === ContentTypes.TOOL_CALL &&
        !prefixTool.tool_call.nameUnavailable
          ? { name: prefixTool.tool_call.name, nameUnavailable: undefined }
          : {}),
      };
      /** Inputs can backfill by tool identity; measured times require the exact step. */
      if (!sameStep) {
        for (const key of [
          'toolPreparationStartedAt',
          'toolDispatchedAt',
          'toolCompletedAt',
          'toolPreparationDurationMs',
          'toolExecutionDurationMs',
        ] as const) {
          const stamp = part.tool_call[key];
          if (stamp == null) delete tool[key];
          else tool[key] = stamp;
        }
      }
      parts[target] = {
        ...part,
        tool_call: {
          ...tool,
          ...getToolTimingDurations({
            observedAt: tool.toolPreparationStartedAt,
            dispatchedAt: tool.toolDispatchedAt,
            completedAt: tool.toolCompletedAt,
          }),
        },
      };
    } else target = part.type === ContentTypes.TEXT ? state.openTextIdx! : state.openThinkIdx!;
    indices.set(index, target);
  }
  const bounded = boundContentParts(parts, {
    ...previous.aggregatorState,
    messagePhaseByStepId: inheritMessagePhases
      ? {
          ...prefix.aggregatorState.messagePhaseByStepId,
          ...previous.aggregatorState.messagePhaseByStepId,
        }
      : previous.aggregatorState.messagePhaseByStepId,
    openTextIdx:
      previous.aggregatorState.openTextIdx == null
        ? null
        : (indices.get(previous.aggregatorState.openTextIdx) ?? null),
    openThinkIdx:
      previous.aggregatorState.openThinkIdx == null
        ? null
        : (indices.get(previous.aggregatorState.openThinkIdx) ?? null),
  });
  const offset = prefix.tickerState.lines.length;
  return {
    ...previous,
    contentParts: bounded.parts,
    aggregatorState: bounded.state,
    tickerState: boundTickerState({
      ...previous.tickerState,
      lines: [...prefix.tickerState.lines, ...previous.tickerState.lines],
      textLineIdx:
        previous.tickerState.textLineIdx == null ? null : previous.tickerState.textLineIdx + offset,
      thinkLineIdx:
        previous.tickerState.thinkLineIdx == null
          ? null
          : previous.tickerState.thinkLineIdx + offset,
    }),
    firstActivitySequence: prefix.firstActivitySequence,
    firstActivityEventId: prefix.firstActivityEventId,
    recentEventKeys: [...(prefix.recentEventKeys ?? []), ...(previous.recentEventKeys ?? [])].slice(
      -MAX_RECENT_EVENT_KEYS,
    ),
    droppedCount: (prefix.droppedCount ?? 0) + (previous.droppedCount ?? 0),
    coverage: previous.coverage,
  };
}

function releaseRecoveredActivity(progress: SubagentProgress): SubagentProgress {
  const from = progress.activityReplayFrom;
  const through = progress.activityReplayThrough;
  if (from == null || through == null) return progress;
  const ranges = progress.replaySegments ?? [
    { from: progress.firstActivitySequence ?? 0, through: progress.lastActivitySequence ?? -1 },
  ];
  if (!ranges.some((range) => range.from <= from && range.through >= through)) return progress;
  return { ...progress, activityReplayFrom: undefined, activityReplayThrough: undefined };
}

function foldReplaySegments(
  previous: SubagentProgress | null,
  events: SubagentUpdateEvent[],
  pending: SubagentUpdateEvent[],
): SubagentProgress {
  const segments = (previous?.replaySegments ?? []).map((segment) => ({ ...segment }));
  if (
    segments.length === 0 &&
    previous != null &&
    previous.firstActivitySequence != null &&
    previous.lastActivitySequence != null
  ) {
    const {
      replaySegments: _segments,
      legacyReplayInvocations: _legacy,
      pendingSequencedEvents: _pending,
      ...progress
    } = previous;
    segments.push({
      from: previous.firstActivitySequence,
      through: previous.lastActivitySequence,
      progress,
    });
  }
  const accepted: SubagentUpdateEvent[] = [];
  const ordered = [...events].sort(
    (left, right) => (left.activitySequence ?? 0) - (right.activitySequence ?? 0),
  );
  for (const event of ordered) {
    const sequence = event.activitySequence;
    if (!validActivitySequence(sequence)) {
      const latest = segments[segments.length - 1];
      if (latest != null) {
        const key = eventKey(event);
        if (key != null && latest.progress.recentEventKeys?.includes(key)) continue;
        accepted.push(event);
        latest.progress = foldAcceptedSubagentEvents(latest.progress, [event], 'detached', [])!;
      }
      continue;
    }
    if (segments.some((segment) => sequence >= segment.from && sequence <= segment.through))
      continue;
    accepted.push(event);
    const preceding = segments.find((segment) => segment.through === sequence - 1);
    if (preceding != null) {
      preceding.progress = foldAcceptedSubagentEvents(preceding.progress, [event], 'detached', [])!;
      preceding.through = sequence;
    } else {
      const progress = foldAcceptedSubagentEvents(null, [event], 'detached', [])!;
      segments.push({ from: sequence, through: sequence, progress });
    }
    segments.sort((left, right) => left.from - right.from);
    for (let index = 1; index < segments.length; ) {
      const left = segments[index - 1];
      const right = segments[index];
      if (left.through + 1 !== right.from) {
        index++;
        continue;
      }
      left.progress = prependSubagentReplay(right.progress, left.progress);
      left.through = right.through;
      segments.splice(index, 1);
    }
  }
  /** Sum projection budgets before retaining ranges. Trimming old ranges cannot erase
   * newer displayed content; dropped coverage is not treated as a continuous prefix. */
  let items = 0;
  let bytes = 0;
  let keepFrom = segments.length;
  for (let index = segments.length - 1; index >= 0; index--) {
    const progress = segments[index].progress;
    const addedBytes = encodedBytes(progress.contentParts) + encodedBytes(progress.tickerState);
    if (
      items + progress.contentParts.length > MAX_LIVE_ACTIVITY_ITEMS ||
      bytes + addedBytes > 2 * MAX_LIVE_ACTIVITY_BYTES
    )
      break;
    items += progress.contentParts.length;
    bytes += addedBytes;
    keepFrom = index;
  }
  if (keepFrom > 0) segments.splice(0, Math.min(keepFrom, segments.length - 1));
  while (segments.length > MAX_LIVE_ACTIVITY_ITEMS) segments.shift();
  const latest = segments[segments.length - 1];
  let projection: SubagentProgress = latest.progress;
  for (let index = segments.length - 2; index >= 0; index--)
    projection = prependSubagentReplay(projection, segments[index].progress);
  return {
    ...projection,
    ...acceptedOmissions(previous, accepted),
    pendingSequencedEvents: pending.length === 0 ? undefined : pending,
    activityReplayFrom: previous?.activityReplayFrom,
    activityReplayThrough: previous?.activityReplayThrough,
    coverage: segments.length === 1 && segments[0].from === 0 ? 'complete' : 'suffix',
    replaySegments: segments.length === 1 ? undefined : segments,
  };
}

/** Event-child IDs include a generation invocation and ordinal, deliberately without
 * a task-wide sequence. Use observed identity anchors, not a synthetic resume counter. */
function legacyOrdinal(
  id: string | undefined,
): { invocation: string; ordinal: number } | undefined {
  if (id == null) return undefined;
  const split = id.lastIndexOf(':');
  const ordinal = Number(id.slice(split + 1));
  if (split < 0 || !/^\d+$/.test(id.slice(split + 1)) || !Number.isSafeInteger(ordinal))
    return undefined;
  return { invocation: id.slice(0, split), ordinal };
}

function eventLegacyOrdinal(
  event: SubagentUpdateEvent,
): { invocation: string; ordinal: number } | undefined {
  const order = legacyOrdinal(event.activityEventId);
  return order != null && order.invocation.startsWith(`${event.subagentRunId}:`)
    ? order
    : undefined;
}

function foldLegacyInvocations(
  previous: SubagentProgress | null,
  events: SubagentUpdateEvent[],
  pending: SubagentUpdateEvent[],
  replay = false,
): SubagentProgress {
  const invocations = (previous?.legacyReplayInvocations ?? []).map((entry) => ({ ...entry }));
  const accepted: SubagentUpdateEvent[] = [];
  const order = Array.from(new Set(events.map((event) => eventLegacyOrdinal(event)!.invocation)));
  for (const event of events) {
    const cursor = eventLegacyOrdinal(event)!;
    let entry = invocations.find((item) => item.invocation === cursor.invocation);
    const normalized = { ...event, activitySequence: cursor.ordinal };
    if (entry == null) {
      accepted.push(event);
      const progress = foldAcceptedSubagentEvents(null, [normalized], 'detached', [], true)!;
      entry = { invocation: cursor.invocation, progress };
      invocations.push(entry);
    } else {
      const ranges = entry.progress.replaySegments ?? [
        {
          from: entry.progress.firstActivitySequence ?? 0,
          through: entry.progress.lastActivitySequence ?? -1,
        },
      ];
      if (ranges.some((range) => cursor.ordinal >= range.from && cursor.ordinal <= range.through))
        continue;
      accepted.push(event);
      if (cursor.ordinal <= (entry.progress.lastActivitySequence ?? -1))
        entry.progress = foldReplaySegments(entry.progress, [normalized], []);
      else
        entry.progress = foldAcceptedSubagentEvents(
          entry.progress,
          [normalized],
          'detached',
          [],
          true,
        )!;
    }
  }
  if (replay) {
    const byInvocation = new Map<string, SubagentUpdateEvent[]>();
    for (const event of events) {
      const invocation = eventLegacyOrdinal(event)!.invocation;
      const group = byInvocation.get(invocation);
      if (group == null) byInvocation.set(invocation, [event]);
      else group.push(event);
    }
    for (const entry of invocations) {
      const lifecycle = byInvocation.get(entry.invocation);
      if (lifecycle != null)
        entry.progress = reconcileReplayTiming(
          entry.progress,
          lifecycle.filter(
            (event) =>
              eventLegacyOrdinal(event)!.ordinal <= (entry.progress.lastActivitySequence ?? -1),
          ),
        );
    }
    const anchored = (previous?.legacyReplayInvocations ?? []).map((entry) => entry.invocation);
    for (let index = 0; index < order.length; index++) {
      const invocation = order[index];
      if (anchored.includes(invocation)) continue;
      const nextKnown = order.slice(index + 1).find((next) => anchored.includes(next));
      const position = nextKnown == null ? anchored.length : anchored.indexOf(nextKnown);
      anchored.splice(position, 0, invocation);
    }
    invocations.sort(
      (left, right) => anchored.indexOf(left.invocation) - anchored.indexOf(right.invocation),
    );
  }
  let items = 0;
  let bytes = 0;
  let keepFrom = invocations.length;
  for (let index = invocations.length - 1; index >= 0; index--) {
    const progress = invocations[index].progress;
    const added = encodedBytes(progress.contentParts) + encodedBytes(progress.tickerState);
    if (
      items + progress.contentParts.length > MAX_LIVE_ACTIVITY_ITEMS ||
      bytes + added > 2 * MAX_LIVE_ACTIVITY_BYTES
    )
      break;
    items += progress.contentParts.length;
    bytes += added;
    keepFrom = index;
  }
  if (keepFrom > 0) invocations.splice(0, Math.min(keepFrom, invocations.length - 1));
  while (invocations.length > MAX_LIVE_ACTIVITY_ITEMS) invocations.shift();
  let projection: SubagentProgress = invocations[invocations.length - 1].progress;
  for (let index = invocations.length - 2; index >= 0; index--)
    projection = prependSubagentReplay(projection, invocations[index].progress, false);
  return {
    ...projection,
    ...acceptedOmissions(previous, accepted),
    firstActivitySequence: undefined,
    lastActivitySequence: undefined,
    replaySegments: undefined,
    pendingSequencedEvents: pending.length === 0 ? undefined : pending,
    legacyReplayInvocations: invocations,
    coverage: invocations.every((entry) => entry.progress.coverage === 'complete')
      ? 'complete'
      : 'suffix',
  };
}

function reconcileReplayTiming(
  progress: SubagentProgress,
  events: SubagentUpdateEvent[],
): SubagentProgress {
  const observed = events.filter(
    (event) =>
      event.subagentRunId === progress.subagentRunId &&
      (event.activitySequence == null ||
        event.activitySequence <= (progress.lastActivitySequence ?? -1)),
  );
  const phased = reconcileSubagentMessagePhases(
    progress.contentParts,
    progress.aggregatorState,
    observed,
  );
  const parts = reconcileSubagentToolTimings(phased.parts, observed);
  const segments = progress.replaySegments?.map((segment) => {
    const updated = reconcileReplayTiming(segment.progress, events);
    return updated === segment.progress ? segment : { ...segment, progress: updated };
  });
  const segmentsChanged =
    segments?.some((segment, index) => segment !== progress.replaySegments?.[index]) ?? false;
  if (
    parts === progress.contentParts &&
    phased.state === progress.aggregatorState &&
    !segmentsChanged
  )
    return progress;
  if (segmentsChanged)
    return foldReplaySegments(
      { ...progress, replaySegments: segments },
      [],
      progress.pendingSequencedEvents ?? [],
    );
  const bounded =
    parts === progress.contentParts
      ? { parts, state: phased.state }
      : boundContentParts(parts, phased.state);
  return {
    ...progress,
    contentParts: bounded.parts,
    aggregatorState: bounded.state,
  };
}

/** Reconcile snapshot coverage and bounded client overflow without advancing past an open parent. */
export function reduceSubagentReplay(
  previous: SubagentProgress | null,
  events: SubagentUpdateEvent[],
  parentOpen: boolean,
): SubagentProgress | null {
  if (events.length === 0) {
    const from = previous?.activityReplayFrom;
    const through = previous?.activityReplayThrough;
    if (parentOpen || previous == null || from == null || through == null) return previous;
    const start = Math.max(from, (previous.lastActivitySequence ?? -1) + 1);
    const retainedPending = (previous.pendingSequencedEvents ?? []).filter(
      (event) =>
        event.activitySequence != null &&
        event.activitySequence >= start &&
        event.activitySequence <= through,
    ).length;
    const omitted = Math.max(0, through - start + 1 - retainedPending);
    const acknowledged = closeParentSubagentProgress({
      ...previous,
      activityReplayFrom: undefined,
      activityReplayThrough: undefined,
    });
    if (acknowledged == null || omitted === 0) return acknowledged;
    if ((acknowledged.lastActivitySequence ?? -1) >= through)
      return { ...acknowledged, droppedCount: (acknowledged.droppedCount ?? 0) + omitted };
    /** The retained window expired. Count the rejected range and resume later live frames. */
    return reduceSubagentProgress(
      acknowledged,
      [
        {
          runId: '',
          subagentRunId: previous.subagentRunId,
          subagentType: previous.subagentType,
          subagentAgentId: previous.subagentAgentId ?? '',
          activityEventId: `client-overflow:${through}`,
          activitySequence: through,
          activityDroppedCount: omitted,
          phase: 'message_delta',
          timestamp: new Date().toISOString(),
        },
      ],
      'detached',
      false,
    );
  }
  const firstSequence = events[0].activitySequence;
  const sameRun = previous?.subagentRunId === events[0].subagentRunId;
  let base: SubagentProgress | null = sameRun ? previous : null;
  if (base != null) {
    if (events.every((event) => validActivitySequence(event.activitySequence))) {
      const backfill = events.filter(
        (event) =>
          event.activitySequence! <= (base!.lastActivitySequence ?? -1) &&
          !(
            base!.replaySegments ?? [
              { from: base!.firstActivitySequence ?? 0, through: base!.lastActivitySequence ?? -1 },
            ]
          ).some(
            (range) =>
              event.activitySequence! >= range.from && event.activitySequence! <= range.through,
          ),
      );
      if (backfill.length > 0)
        base = foldReplaySegments(base, backfill, base.pendingSequencedEvents ?? []);
    } else if (events.every((event) => eventLegacyOrdinal(event) != null))
      return foldLegacyInvocations(base, events, base.pendingSequencedEvents ?? [], true);
  }
  const folded = reduceSubagentProgress(base, events, 'detached', parentOpen);
  if (folded == null) return previous;
  const progress = reconcileReplayTiming(folded, events);
  const missing = sameRun ? previous?.activityReplayFrom : undefined;
  if (parentOpen || missing == null || (progress.lastActivitySequence ?? -1) < missing)
    return progress;
  const start = Math.max(missing, (base?.lastActivitySequence ?? -1) + 1);
  const retainedPending = (base?.pendingSequencedEvents ?? []).filter(
    (event) =>
      event.activitySequence != null &&
      event.activitySequence >= start &&
      event.activitySequence < (firstSequence ?? start),
  ).length;
  return {
    ...progress,
    activityReplayFrom: undefined,
    activityReplayThrough: undefined,
    droppedCount:
      (progress.droppedCount ?? 0) +
      Math.max(0, (firstSequence ?? start) - start - retainedPending),
  };
}

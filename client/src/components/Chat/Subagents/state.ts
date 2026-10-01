import { useEffect } from 'react';
import { atomFamily } from 'jotai/utils';
import { atom, useAtomValue, useStore } from 'jotai';
import { ContentTypes } from 'librechat-data-provider';
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
  /** Bounded future frames waiting for an earlier sequence at the parent/detached handoff. */
  pendingSequencedEvents?: SubagentUpdateEvent[];
  /** Whether the folded events cover the run from its beginning or only the
   *  forward-only suffix observed after opening a detached task stream. */
  coverage?: 'complete' | 'suffix';
}

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

const foldAcceptedSubagentEvents = (
  previous: SubagentProgress | null,
  events: SubagentUpdateEvent[],
  source: 'parent' | 'detached',
  pendingSequencedEvents: SubagentUpdateEvent[],
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
    status: last.phase,
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
      if (sequence < expected || pendingSequences.has(sequence)) continue;
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
      }
    } else {
      if (key != null) seen.add(key);
      directEvents.push(event);
    }
  }
  drainPending();
  if (
    !waitForEarlierSequences &&
    pending[0]?.activitySequence != null &&
    pending[0].activitySequence > expected
  ) {
    expected = pending[0].activitySequence;
    drainPending();
  }
  return foldAcceptedSubagentEvents(previous, directEvents, source, pending);
}

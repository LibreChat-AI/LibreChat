import { useCallback, useRef } from 'react';
import { useStore } from 'jotai';
import {
  reduceStep,
  flushSummary,
  flushResponses,
  resetStreamState,
  syncStreamMessage,
  createStreamState,
  subagentProgressKey,
} from '@librechat/chat';
import type {
  TMessage,
  EventSubmission,
  SubagentUpdateEvent,
  PtcToolCallEvent,
} from 'librechat-data-provider';
import type { StepEvent, StepEffect, StepContext, StreamState } from '@librechat/chat';
import type { AnnounceOptions } from '~/common';
import {
  activeSubagentPanel,
  closeParentSubagentProgress,
  listRegisteredSubagentProgressKeys,
  reduceSubagentProgress,
  registerSubagentProgressKey,
  removeSubagentProgressAtoms,
  subagentParentStreamOpenByToolCallId,
  subagentProgressByToolCallId,
  takeRegisteredSubagentProgressKeys,
} from '~/components/Chat/Subagents/state';
import { ptcTraceByToolCallId, EMPTY_PTC_TRACE, PTC_TRACE_MAX_ENTRIES, ptcTraceKey } from './ptc';
import { sandboxStartingByToolCallId } from './sandbox';
import { MESSAGE_UPDATE_INTERVAL } from '~/common';

type TUseStepHandler = {
  announcePolite: (options: AnnounceOptions) => void;
  setMessages: (messages: TMessage[]) => void;
  getMessages: () => TMessage[] | undefined;
  lastAnnouncementTimeRef: React.MutableRefObject<number>;
  /**
   * Fired when a completed `create_file`/`edit_file` call targeted a
   * `skills/...` path. The caller owns the side effect (skill query cache
   * invalidation) so this hook stays free of query-client coupling.
   */
  onSkillAuthoringComplete?: () => void;
  onSubagentIndexChange?: (conversationId: string) => void;
};

export default function useStepHandler({
  setMessages,
  getMessages,
  announcePolite,
  lastAnnouncementTimeRef,
  onSkillAuthoringComplete,
  onSubagentIndexChange,
}: TUseStepHandler) {
  const subagentStore = useStore();
  const stream = useRef<StreamState>(createStreamState());
  /** Coalesces rapid-fire summarize delta renders into a single rAF frame */
  const summarizeDeltaRaf = useRef<number | null>(null);
  /** Coalesces per-token message/reasoning delta cache writes into one rAF frame.
   * `deltaFlushScheduled` (not the handle) gates scheduling: the handle is
   * assigned after `requestAnimationFrame` returns, which would race a
   * synchronously-invoked callback. */
  const messageDeltaRaf = useRef<number | null>(null);
  const deltaFlushScheduled = useRef(false);
  const pendingDeltaFlushIds = useRef(new Set<string>());
  const pendingDeltaFlushRef = useRef<(() => void) | null>(null);

  /** Both content parts and ticker lines are aggregated incrementally
   *  into the atom as each `ON_SUBAGENT_UPDATE` arrives; we never
   *  retain the raw event array, so no rolling window is needed. A
   *  talkative subagent can emit thousands of deltas without growing
   *  memory past what the structural output requires. */
  const applySubagentProgress = useCallback(
    (invocationKey: string, events: SubagentUpdateEvent[]): void => {
      registerSubagentProgressKey(invocationKey);
      subagentStore.set(subagentParentStreamOpenByToolCallId(invocationKey), true);
      subagentStore.set(subagentProgressByToolCallId(invocationKey), (prev) =>
        reduceSubagentProgress(prev, events, 'parent', true),
      );
    },
    [subagentStore],
  );

  /** Navigation retains the selected durable task; host teardown drains every invocation. */
  const resetSubagentAtoms = useCallback(
    ({ preserveSelectedTask = false }: { preserveSelectedTask?: boolean } = {}): void => {
      const selected = preserveSelectedTask ? subagentStore.get(activeSubagentPanel) : null;
      const retainedKey =
        selected?.host === 'conversation' && selected.durable != null
          ? subagentProgressKey(
              selected.parentMessageId,
              selected.event?.progressKey ?? selected.toolCallId,
              selected.partIndex,
            )
          : null;
      for (const invocationKey of takeRegisteredSubagentProgressKeys()) {
        subagentStore.set(subagentParentStreamOpenByToolCallId(invocationKey), false);
        if (invocationKey === retainedKey) {
          registerSubagentProgressKey(invocationKey);
          subagentStore.set(
            subagentProgressByToolCallId(invocationKey),
            closeParentSubagentProgress,
          );
          continue;
        }
        subagentStore.set(subagentProgressByToolCallId(invocationKey), null);
        removeSubagentProgressAtoms(invocationKey);
      }
    },
    [subagentStore],
  );

  const closeParentSubagentStreams = useCallback((): void => {
    for (const invocationKey of listRegisteredSubagentProgressKeys()) {
      subagentStore.set(subagentParentStreamOpenByToolCallId(invocationKey), false);
      subagentStore.set(subagentProgressByToolCallId(invocationKey), closeParentSubagentProgress);
    }
  }, [subagentStore]);

  /** Tool-call ids whose sandbox-starting atom is set, so completion can clear them. */
  const knownSandboxAtomKeys = useRef(new Set<string>());

  const sandboxStore = useStore();
  const setSandboxStarting = useCallback(
    (toolCallId: string): void => {
      knownSandboxAtomKeys.current.add(toolCallId);
      sandboxStore.set(sandboxStartingByToolCallId(toolCallId), true);
    },
    [sandboxStore],
  );

  const clearSandboxStarting = useCallback(
    (toolCallId?: string | null): void => {
      if (!toolCallId || !knownSandboxAtomKeys.current.has(toolCallId)) {
        return;
      }
      knownSandboxAtomKeys.current.delete(toolCallId);
      sandboxStore.set(sandboxStartingByToolCallId(toolCallId), false);
    },
    [sandboxStore],
  );

  const resetSandboxAtoms = useCallback((): void => {
    for (const toolCallId of knownSandboxAtomKeys.current) {
      sandboxStore.set(sandboxStartingByToolCallId(toolCallId), false);
    }
    knownSandboxAtomKeys.current.clear();
  }, [sandboxStore]);

  /** PTC tool call ids with a live trace, so the atoms can be released. */
  const knownPtcAtomKeys = useRef(new Set<string>());
  const ptcStore = useStore();

  /**
   * Folds one `on_ptc_tool_call` envelope into its program's trace: the
   * `running` event appends a row, the settling event updates that row in
   * place by `call_id`. Order follows the sandbox's dispatch order, which is
   * what the code reads like; a round trip can settle out of order.
   */
  const applyPtcToolCall = useCallback(
    (event: PtcToolCallEvent, parentMessageId: string): void => {
      const { tool_call_id: toolCallId, call_id: callId, name, status } = event;
      /** No parent message means no occurrence to scope this to; a raw
       *  `tool_call_id` would leak the rows into whichever card reused it. */
      if (!toolCallId || !callId || !parentMessageId) {
        return;
      }
      const atomKey = ptcTraceKey(parentMessageId, toolCallId);
      knownPtcAtomKeys.current.add(atomKey);
      ptcStore.set(ptcTraceByToolCallId(atomKey), (previous) => {
        const index = previous.entries.findIndex((entry) => entry.callId === callId);
        const entry = {
          callId,
          name,
          status,
          ...(event.args ? { args: event.args } : {}),
          ...(event.error ? { error: event.error } : {}),
          ...(event.durationMs != null ? { durationMs: event.durationMs } : {}),
        };

        if (index !== -1) {
          const next = [...previous.entries];
          next[index] = { ...previous.entries[index], ...entry };
          return { entries: next, dropped: previous.dropped };
        }

        /** A settle whose row is gone, evicted by the cap, or pruned across
         *  a resume gap, must not reappear at the tail out of order. */
        if (status !== 'running') {
          return previous;
        }

        const appended = [...previous.entries, entry];
        const overflow = appended.length - PTC_TRACE_MAX_ENTRIES;
        if (overflow <= 0) {
          return { entries: appended, dropped: previous.dropped };
        }
        return {
          entries: appended.slice(overflow),
          dropped: previous.dropped + overflow,
        };
      });
    },
    [ptcStore],
  );

  const resetPtcAtoms = useCallback((): void => {
    for (const atomKey of knownPtcAtomKeys.current) {
      ptcStore.set(ptcTraceByToolCallId(atomKey), EMPTY_PTC_TRACE);
      ptcTraceByToolCallId.remove(atomKey);
    }
    knownPtcAtomKeys.current.clear();
  }, [ptcStore]);

  /**
   * Settles rows still marked `running` after a stream gap as `interrupted`.
   * Inner calls carry no durable state: they are not content parts, so the
   * resume snapshot cannot rebuild them and a settling event lost in the gap
   * is never replayed, and that means such a row would otherwise spin forever.
   *
   * Marked, not removed: a call can also still be executing across the
   * reconnect, and its settling event then arrives normally on the restored
   * live stream. That event updates this row in place, so the call reports its
   * real outcome. Deleting the row would strand it: a settle whose row is
   * gone is dropped rather than re-appended out of order, and the call would
   * vanish from the trace despite having run. Settled rows are untouched.
   */
  const prunePtcTraces = useCallback((): void => {
    for (const atomKey of knownPtcAtomKeys.current) {
      ptcStore.set(ptcTraceByToolCallId(atomKey), (previous) =>
        previous.entries.some((entry) => entry.status === 'running')
          ? {
              ...previous,
              entries: previous.entries.map((entry) =>
                entry.status === 'running' ? { ...entry, status: 'interrupted' as const } : entry,
              ),
            }
          : previous,
      );
    }
  }, [ptcStore]);

  /**
   * Per-token deltas fold into the stream state immediately (authoritative), but
   * the cache write, and the buildTree + message-tree walk it triggers,
   * flushes at most once per frame. Non-delta events keep writing
   * synchronously from the stream state, so a trailing flush after them merges
   * the same authoritative state; `clearStepMaps` cancels the flush at run
   * boundaries (same lifecycle as the summarize coalescing).
   */
  const scheduleCoalescedMessagesFlush = useCallback(
    (responseMessageId: string, messages: TMessage[], ctx: StepContext) => {
      pendingDeltaFlushIds.current.add(responseMessageId);
      const flush = () => {
        deltaFlushScheduled.current = false;
        messageDeltaRaf.current = null;
        pendingDeltaFlushRef.current = null;
        const ids = pendingDeltaFlushIds.current;
        pendingDeltaFlushIds.current = new Set();
        flushResponses(stream.current, ctx, ids, messages);
      };
      /** Exposed so terminal/read boundaries (abort, error, pending-action)
       * can apply the queued tokens synchronously via `flushPendingDeltas`. */
      pendingDeltaFlushRef.current = flush;
      if (deltaFlushScheduled.current) {
        return;
      }
      deltaFlushScheduled.current = true;
      messageDeltaRaf.current = requestAnimationFrame(flush);
    },
    [],
  );

  const applyEffects = useCallback(
    (effects: StepEffect[], ctx: StepContext): void => {
      for (const effect of effects) {
        switch (effect.type) {
          case 'flush':
            scheduleCoalescedMessagesFlush(effect.messageId, effect.messages, ctx);
            break;
          case 'summary':
            if (summarizeDeltaRaf.current == null) {
              summarizeDeltaRaf.current = requestAnimationFrame(() => {
                summarizeDeltaRaf.current = null;
                flushSummary(stream.current, ctx, effect.messageId, effect.messages);
              });
            }
            break;
          case 'announce':
            announcePolite({ message: effect.message, isStatus: true });
            break;
          case 'sandbox-starting':
            setSandboxStarting(effect.toolCallId);
            break;
          case 'sandbox-settled':
            clearSandboxStarting(effect.toolCallId);
            break;
          case 'skill-authored':
            onSkillAuthoringComplete?.();
            break;
          case 'ptc':
            applyPtcToolCall(effect.event, effect.parentMessageId);
            break;
          case 'subagent':
            applySubagentProgress(effect.invocationKey, effect.events);
            break;
          case 'subagent-index':
            onSubagentIndexChange?.(effect.conversationId);
            break;
        }
      }
    },
    [
      announcePolite,
      setSandboxStarting,
      clearSandboxStarting,
      onSkillAuthoringComplete,
      applyPtcToolCall,
      applySubagentProgress,
      onSubagentIndexChange,
      scheduleCoalescedMessagesFlush,
    ],
  );

  const stepHandler = useCallback(
    (stepEvent: StepEvent, submission: EventSubmission) => {
      const currentTime = Date.now();
      if (currentTime - lastAnnouncementTimeRef.current > MESSAGE_UPDATE_INTERVAL) {
        announcePolite({ message: 'composing', isStatus: true });
        lastAnnouncementTimeRef.current = currentTime;
      }
      const ctx: StepContext = { submission, getMessages, setMessages };
      applyEffects(reduceStep(stream.current, stepEvent, ctx), ctx);
    },
    [getMessages, setMessages, announcePolite, applyEffects, lastAnnouncementTimeRef],
  );

  /** Cancels a queued delta flush so it can't overwrite a terminal write:
   * once a final handler has written the server's authoritative message, a
   * trailing frame reading the older streaming copy from the stream state must
   * never land on top of it. */
  const cancelPendingDeltaFlush = useCallback(() => {
    if (messageDeltaRaf.current != null) {
      cancelAnimationFrame(messageDeltaRaf.current);
      messageDeltaRaf.current = null;
    }
    deltaFlushScheduled.current = false;
    pendingDeltaFlushRef.current = null;
    pendingDeltaFlushIds.current.clear();
  }, []);

  /** Applies a queued delta flush synchronously (then cancels the frame).
   * For boundaries that READ the cache or synthesize from it (abort's
   * partial-response capture, error cards, pending-action application), the
   * queued tokens must land first or the stopped/errored message loses them. */
  const flushPendingDeltas = useCallback(() => {
    if (messageDeltaRaf.current != null) {
      cancelAnimationFrame(messageDeltaRaf.current);
      messageDeltaRaf.current = null;
    }
    const flush = pendingDeltaFlushRef.current;
    pendingDeltaFlushRef.current = null;
    deltaFlushScheduled.current = false;
    if (flush) {
      flush();
    }
  }, []);

  const clearStepMaps = useCallback(() => {
    if (summarizeDeltaRaf.current != null) {
      cancelAnimationFrame(summarizeDeltaRaf.current);
      summarizeDeltaRaf.current = null;
    }
    cancelPendingDeltaFlush();
    resetStreamState(stream.current);
    closeParentSubagentStreams();
    /** Unlike subagent atoms below, sandbox-starting flags are transient
     *  status with no audit value; reset them at this boundary so an
     *  interrupted cold boot can't leak a stale "starting" label onto a
     *  later tool call that reuses the same id (e.g. `call_0`). */
    resetSandboxAtoms();
    /** Intentionally NOT calling `resetSubagentAtoms()` here: users need
     *  to be able to reopen the SubagentCall dialog after completion to
     *  audit what the child did. `resetSubagentAtoms` is returned below
     *  so callers can wipe atoms on conversation-switch (see
     *  `useEventHandlers`); that's the correct cleanup boundary:
     *  persisted `subagent_content` takes over for historical messages
     *  once the conversation is saved, and we prevent unbounded
     *  atomFamily growth across multi-conversation sessions. */
  }, [cancelPendingDeltaFlush, closeParentSubagentStreams, resetSandboxAtoms]);

  /**
   * Sync a message into the step handler's streaming copy.
   * Call this after receiving sync event to ensure subsequent deltas
   * build on the synced content, not stale content.
   */
  const syncStepMessage = useCallback(
    (message: TMessage) => {
      for (const effect of syncStreamMessage(stream.current, message)) {
        if (effect.type === 'subagent') {
          applySubagentProgress(effect.invocationKey, effect.events);
        }
      }
    },
    [applySubagentProgress],
  );

  return {
    stepHandler,
    clearStepMaps,
    resetSubagentAtoms,
    resetPtcAtoms,
    prunePtcTraces,
    syncStepMessage,
    cancelPendingDeltaFlush,
    flushPendingDeltas,
  };
}

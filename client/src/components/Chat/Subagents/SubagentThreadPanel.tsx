import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 } from 'uuid';
import { useAtom, useSetAtom, useStore } from 'jotai';
import { Clock, OctagonPause, X, Zap } from 'lucide-react';
import { dataService, ForkOptions } from 'librechat-data-provider';
import {
  Alert,
  Button,
  Composer,
  ControlCombobox,
  OverlayBack,
  useMediaQuery,
  useToastContext,
} from '@librechat/client';
import type {
  ParentSubagentTaskSummary,
  SubagentControlAction,
  SubagentControlReceipt,
  SubagentControlRequest,
} from 'librechat-data-provider';
import type { ComposerKeyVerdict, ComposerStopProps, SendAction } from '@librechat/client';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { ActiveSubagentPanel, SubagentControlUiState } from './state';
import type { ComposerKeyAction } from '~/utils/shortcuts';
import type { OptionWithIcon } from '~/common';
import {
  adaptDurableThreadActivity,
  adaptDurableThreadConversation,
  adaptLivePersistedActivity,
  mergeChildConversationTurns,
  retainBoundedMovingWindowTurns,
} from './adapters';
import {
  ACTIVE_THREAD_REFRESH_MS,
  subagentThreadHasTaskEvidence,
  useForkConvoMutation,
  useSubagentControlMutation,
  useSubagentThreadQuery,
} from '~/data-provider';
import {
  activeSubagentPanel,
  subagentControlStateByTask,
  subagentControlStateKey,
  subagentProgressKey,
  useSubagentProgress,
} from './state';
import useSubagentActivityStream from '~/data-provider/Subagents/useSubagentActivityStream';
import SubagentActivity, { SubagentActivityScrollSurface } from './SubagentActivity';
import ApprovalProvider from '~/components/Chat/Messages/Content/ApprovalContext';
import { isMacPlatform, resolveComposerKeyDown } from '~/utils/shortcuts';
import { useFocusTrap, useLocalize, useNavigateToConvo } from '~/hooks';
import { useConfiguredFooter } from '~/components/Chat/Footer';
import { useParentSubagents } from './ParentSubagentsProvider';
import SubagentConversation from './SubagentConversation';
import { eventSubagentSelection } from './eventSelection';
import { resolveSubagentAgentId } from './identity';
import { useAgentsMapContext } from '~/Providers';
import { isLiveSubagentStatus } from './status';
import { cn, renderAgentAvatar } from '~/utils';
import { useChatSurface } from './surface';

const EVENT_TASK_PAGE_SIZE = 3;
const TERMINAL_CONTROL_REASONS = new Set([
  'task_not_running',
  'task_completed',
  'task_cancelled',
  'task_failed',
]);

const isTerminalControlReason = (reason?: string): boolean =>
  reason != null && TERMINAL_CONTROL_REASONS.has(reason);

const closesTaskControls = (receipt: SubagentControlReceipt): boolean =>
  isTerminalControlReason(receipt.reason) ||
  (receipt.action === 'cancel' && receipt.status === 'applied');

const responseStatus = (error: unknown): number | undefined =>
  typeof error === 'object' &&
  error != null &&
  'response' in error &&
  typeof error.response === 'object' &&
  error.response != null &&
  'status' in error.response &&
  typeof error.response.status === 'number'
    ? error.response.status
    : undefined;

const failedControlReason = (
  inaccessible: boolean,
  retryable: boolean,
): 'task_inaccessible' | 'owner_unavailable' | 'invalid_command' => {
  if (inaccessible) return 'task_inaccessible';
  if (retryable) return 'owner_unavailable';
  return 'invalid_command';
};

/** Which control a during-run verdict asks for. `submit` is whatever the
 *  reader's own key policy treats as the default — with Enter-to-send off that
 *  is ⌘/Ctrl+Enter, which is why the chord is never read raw. */
const CONTROL_FOR_ACTION = {
  submit: 'steer',
  other: 'queue',
  interrupt: 'interrupt',
  preempt: 'interrupt',
} as const satisfies Partial<Record<ComposerKeyAction, SubagentControlAction>>;

const failedControlLocaleKey = (reason?: string) => {
  if (reason === 'task_inaccessible') return 'com_ui_subagent_control_reason_task_inaccessible';
  if (reason === 'owner_unavailable') return 'com_ui_subagent_control_reason_owner_unavailable';
  return 'com_ui_subagent_control_reason_invalid_command';
};

export default function SubagentThreadPanel({ selection }: { selection: ActiveSubagentPanel }) {
  /** The shell carries the deployment's answer, so this surface lays out once,
   *  like the composer beside it. */
  const clearsFooter = useConfiguredFooter();
  const localize = useLocalize();
  const panelStore = useStore();
  const { showToast } = useToastContext();
  const { navigateToConvo } = useNavigateToConvo();
  const panelRef = useRef<HTMLDivElement>(null);
  const isMobile = useMediaQuery('(max-width: 767px)');
  /** Two reasons the send control's action list cannot be used where it hangs.
   *  Without hover, a tap on its anchor submits instead of opening it. And
   *  while the panel is a focus-trapped modal, the list is portaled outside the
   *  `aside` the trap knows, so Tab never reaches it. Either way those readers
   *  get the same actions as controls of their own, inside the panel. */
  const coarsePointer = useMediaQuery('(hover: none)');
  const {
    enterToSend,
    handOffComposerText,
    composerBindings: { shortcutsEnabled, submitOverride, yieldedChords },
  } = useChatSurface();
  const [actorPickerOpen, setActorPickerOpen] = useState(false);
  /** A continuation is out. Declared here because the selection-advance effect
   *  below has to defer to it, well before the mutation itself exists. */
  const [continuationPending, setContinuationPending] = useState(false);
  const [controlMessage, setControlMessage] = useState('');
  /** Unsent words in the composer are enough on their own: whatever put them
   *  there, an advance would change the control identity and wipe them. */
  const selectionHeldForDraft = continuationPending || controlMessage.trim() !== '';
  const setSelection = useSetAtom(activeSubagentPanel);
  const resetSelection = useCallback(() => setSelection(null), [setSelection]);
  const agentsMap = useAgentsMapContext();
  const { byMessageId, byThreadId, refresh } = useParentSubagents();
  const progress = useSubagentProgress(
    subagentProgressKey(
      selection.parentMessageId,
      selection.event?.progressKey ?? selection.toolCallId,
      selection.partIndex,
    ),
  );
  const foregroundAgentId = resolveSubagentAgentId(progress, selection.subagentIdentity);
  const foregroundAgent = foregroundAgentId == null ? undefined : agentsMap?.[foregroundAgentId];
  const foregroundTitle =
    selection.subagentType === 'self'
      ? localize('com_ui_subagent_dialog_title_self')
      : localize('com_ui_subagent_dialog_title', {
          0: foregroundAgent?.name || selection.subagentType,
        });
  const threadId = selection.durable?.threadId ?? '';
  const taskId = selection.durable?.taskId ?? '';
  const controlIdentity = subagentControlStateKey(selection.parentConversationId, threadId, taskId);
  const [controlState, setControlState] = useAtom(subagentControlStateByTask(controlIdentity));
  const setControlStateForIdentity = useCallback(
    (identity: string, state: SubagentControlUiState | null) =>
      panelStore.set(subagentControlStateByTask(identity), state),
    [panelStore],
  );
  const transientControl = controlState?.receipt ?? null;
  const retryControl = controlState?.retry ?? null;
  const eventSummary = selection.event == null ? undefined : byThreadId.get(threadId);
  const eventTaskCount = eventSummary?.tasks.length ?? 0;
  const [eventTaskWindow, setEventTaskWindow] = useState(() => ({
    threadId,
    count: EVENT_TASK_PAGE_SIZE,
    taskCount: eventSummary == null ? null : eventTaskCount,
  }));
  useEffect(() => {
    setEventTaskWindow((current) => {
      if (current.threadId !== threadId || current.taskCount == null) {
        return { threadId, count: EVENT_TASK_PAGE_SIZE, taskCount: eventTaskCount };
      }
      const appended = Math.max(0, eventTaskCount - current.taskCount);
      return {
        threadId,
        count: Math.min(eventTaskCount, current.count + appended),
        taskCount: eventTaskCount,
      };
    });
  }, [eventTaskCount, threadId]);
  const visibleEventTaskCount = Math.min(
    eventTaskCount,
    eventTaskWindow.threadId === threadId ? eventTaskWindow.count : EVENT_TASK_PAGE_SIZE,
  );
  const visibleEventTasks = useMemo(
    () => (eventSummary?.tasks ?? []).slice(0, visibleEventTaskCount).reverse(),
    [eventSummary?.tasks, visibleEventTaskCount],
  );
  const hasEarlierRetainedTasks = visibleEventTaskCount < eventTaskCount;
  const eventTaskRunning =
    eventSummary?.tasks.find((task) => task.taskId === taskId)?.status === 'running';
  const eventSiblings = useMemo(() => {
    if (selection.event == null) return [];
    const seen = new Set<string>();
    return (selection.event.siblingParentMessageIds ?? [selection.parentMessageId])
      .flatMap((parentMessageId) => byMessageId.get(parentMessageId) ?? [])
      .filter((child) => {
        if (seen.has(child.threadId)) return false;
        seen.add(child.threadId);
        return true;
      });
  }, [byMessageId, selection.event, selection.parentMessageId]);
  const selectedEventActor = eventSiblings.find((child) => child.threadId === threadId);
  const selectedEventActorName =
    (selectedEventActor?.agentId == null
      ? undefined
      : agentsMap?.[selectedEventActor.agentId]?.name) ??
    selectedEventActor?.actorId ??
    eventSummary?.actorId ??
    foregroundTitle;
  const { data, isLoading, isError, isPreviousData, isReadinessPending, refetch } =
    useSubagentThreadQuery(selection.parentConversationId, threadId, taskId, {
      /** A new delivery re-keys this query to its task. Keeping the previous
       *  thread view mounted while the fresh one loads stops the whole panel
       *  from flashing back to a loading dot on every incoming event. */
      keepPreviousData: true,
      ...(eventTaskRunning ? { refetchInterval: ACTIVE_THREAD_REFRESH_MS } : {}),
    });
  /** Retention crosses every key change, including actor switches. A retained
   *  view is only meaningful while it describes the SAME child thread; within
   *  that thread its turn/history rows stay valid across task re-keys, while
   *  task-scoped fields (selected activity, status, control receipts) must not
   *  be attributed to the newly selected task. */
  const threadView = data?.threadId === threadId ? data : undefined;
  const taskView = isPreviousData ? undefined : threadView;
  const latestHistoryGeneration = JSON.stringify([
    threadView?.nextCursor ?? null,
    ...(threadView?.turns?.map((turn) => turn.taskId) ?? []),
  ]);
  const latestHistoryGenerationRef = useRef(latestHistoryGeneration);
  latestHistoryGenerationRef.current = latestHistoryGeneration;
  const durableTerminal =
    subagentThreadHasTaskEvidence(taskView, taskId) &&
    (taskView?.status === 'completed' ||
      taskView?.status === 'failed' ||
      taskView?.status === 'interrupted' ||
      taskView?.status === 'cancelled');
  const priorTerminalRef = useRef(false);
  useSubagentActivityStream(selection, !durableTerminal || eventTaskRunning);

  useEffect(() => {
    if (selection.event == null) return;
    void refresh();
  }, [refresh, selection.event, threadId]);

  useEffect(() => {
    priorTerminalRef.current = false;
  }, [taskId, threadId]);

  useEffect(() => {
    if (selection.event == null) return;
    if (durableTerminal && !priorTerminalRef.current) void refresh();
    priorTerminalRef.current = durableTerminal;
  }, [durableTerminal, refresh, selection.event]);

  useEffect(() => {
    if (selection.event == null || !eventTaskRunning || !durableTerminal) return;
    void refetch();
  }, [durableTerminal, eventTaskRunning, refetch, selection.event]);
  useEffect(() => {
    if (
      selection.event == null ||
      selection.event.pinnedTask === true ||
      /** An advance changes the control identity, which empties the composer.
       *  Defer while anything unsent is in it — a draft not yet submitted, one
       *  travelling with a continuation in flight, or one left behind by a
       *  continuation that failed and is waiting to be retried. The hold
       *  releases itself once the draft is sent or cleared. */
      selectionHeldForDraft ||
      eventSummary?.latestTaskId == null ||
      eventSummary.latestTaskId === taskId
    ) {
      return;
    }
    const nextSelection = eventSubagentSelection(
      selection.parentConversationId,
      eventSummary,
      selection.event.siblingParentMessageIds,
    );
    if (nextSelection != null) setSelection(nextSelection);
  }, [eventSummary, selection, selectionHeldForDraft, setSelection, taskId]);
  const detachedLiveSubmitting =
    selection.durable != null &&
    progress != null &&
    progress.status !== 'stop' &&
    progress.status !== 'error';

  const controlMessageRef = useRef(controlMessage);
  controlMessageRef.current = controlMessage;
  /** The continuation in flight, bound to the selection that asked for it. The
   *  fork lands a round trip later and the panel stays live for it, so the live
   *  field is the better source — but ONLY while it still belongs to the actor
   *  that made the request. Switch actors mid-flight and the words in the field
   *  are the new actor's, so this falls back to what was there at submission. */
  const continuationRef = useRef<{ identity: string; text: string } | null>(null);
  const continueChat = useForkConvoMutation({
    onSuccess: (result) => {
      const continuedConversationId = result.conversation?.conversationId;
      /** The server keeps child threads view-only (`CHILD_THREAD_READ_ONLY_ERROR`),
       *  so a continuation is a real conversation forked from the thread. Hand
       *  what the reader typed to that conversation's composer instead of
       *  dropping it with this panel — in memory, since an unsent draft must not
       *  be written to storage the reader may have asked not to use. */
      const continuation = continuationRef.current;
      continuationRef.current = null;
      setContinuationPending(false);
      /** While the field still belongs to this continuation it IS the draft,
       *  verbatim — including when the reader has emptied it since, which is
       *  them withdrawing the words rather than leaving them behind. Only a
       *  composer that has moved to another selection falls back to what was
       *  captured at submission. */
      const stillItsOwnComposer = continuation?.identity === controlSelectionRef.current;
      const draft = stillItsOwnComposer
        ? controlMessageRef.current.trim()
        : (continuation?.text ?? '');
      if (continuedConversationId != null && draft !== '') {
        handOffComposerText(continuedConversationId, draft);
      }
      if (stillItsOwnComposer) setControlMessage('');
      resetSelection();
      navigateToConvo(result.conversation);
    },
    onError: () => {
      /** The panel stays open on a failed continuation, and the composer still
       *  holds the words, so there is nothing to restore. */
      continuationRef.current = null;
      setContinuationPending(false);
      showToast({ message: localize('com_ui_continue_chat_error'), status: 'error' });
    },
  });
  const [turnDetailOverrides, setTurnDetailOverrides] = useState(
    () => new Map<string, ReturnType<typeof adaptDurableThreadActivity>>(),
  );
  const [turnDetailStates, setTurnDetailStates] = useState(
    () => new Map<string, 'idle' | 'loading' | 'unavailable' | 'error'>(),
  );
  const [olderTurns, setOlderTurns] = useState<ReturnType<typeof adaptDurableThreadConversation>>(
    [],
  );
  const [movingWindowTurns, setMovingWindowTurns] = useState<
    ReturnType<typeof adaptDurableThreadConversation>
  >([]);
  const [rebaseTurns, setRebaseTurns] = useState<ReturnType<typeof adaptDurableThreadConversation>>(
    [],
  );
  const [postRebaseTurns, setPostRebaseTurns] = useState<
    ReturnType<typeof adaptDurableThreadConversation>
  >([]);
  const postRebaseTurnsRef = useRef(postRebaseTurns);
  const [historyRebaseActive, setHistoryRebaseActive] = useState(false);
  const historyRebaseActiveRef = useRef(historyRebaseActive);
  const [historyCursor, setHistoryCursor] = useState<string | null | undefined>(undefined);
  const [historyCursorGeneration, setHistoryCursorGeneration] = useState<string>();
  const [historyState, setHistoryState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [historyBoundaryUnavailable, setHistoryBoundaryUnavailable] = useState(false);
  const activeThreadRef = useRef(threadId);
  const selectionThreadRef = useRef(threadId);
  const selectionGenerationRef = useRef(0);
  /** Locally retained turn buffers reset in a passive effect; until it has run
   *  for the current thread they still hold the previous thread's turns and
   *  must not render. Stamped inside that reset effect. */
  const retainedTurnsGenerationRef = useRef(0);
  const turnDetailRequestsRef = useRef(new Set<string>());
  const historyRequestRef = useRef<string | null>(null);
  const historyHasLoadedRef = useRef(false);
  if (selectionThreadRef.current !== threadId) {
    selectionThreadRef.current = threadId;
    selectionGenerationRef.current += 1;
  }
  activeThreadRef.current = threadId;
  const [controlInaccessible, setControlInaccessible] = useState(false);
  const [controlsClosed, setControlsClosed] = useState(false);
  const controlInFlightRef = useRef(false);
  const controlSelectionRef = useRef(controlIdentity);
  useEffect(() => {
    controlSelectionRef.current = controlIdentity;
    setControlMessage('');
    setControlInaccessible(false);
    setControlsClosed(false);
    controlInFlightRef.current = false;
    return () => {
      controlSelectionRef.current = '';
    };
  }, [controlIdentity]);

  useEffect(() => {
    setTurnDetailOverrides(new Map());
    setTurnDetailStates(new Map());
    setOlderTurns([]);
    setMovingWindowTurns([]);
    setRebaseTurns([]);
    setPostRebaseTurns([]);
    retainedTurnsGenerationRef.current = selectionGenerationRef.current;
    postRebaseTurnsRef.current = [];
    setHistoryRebaseActive(false);
    historyRebaseActiveRef.current = false;
    setHistoryCursor(undefined);
    setHistoryCursorGeneration(undefined);
    setHistoryState('idle');
    setHistoryBoundaryUnavailable(false);
    turnDetailRequestsRef.current.clear();
    historyRequestRef.current = null;
    historyHasLoadedRef.current = false;
  }, [threadId]);

  useEffect(() => {
    if (
      threadView != null &&
      (threadView.historyUnavailable === true ||
        (threadView.historyTruncated === true && threadView.nextCursor == null))
    ) {
      setHistoryBoundaryUnavailable(true);
    }
  }, [threadView]);

  const loadTurnDetails = useCallback(
    async (detailTaskId: string) => {
      const requestedThreadId = threadId;
      const requestedGeneration = selectionGenerationRef.current;
      const requestKey = `${requestedGeneration}\u0000${requestedThreadId}\u0000${detailTaskId}`;
      if (
        turnDetailStates.get(detailTaskId) === 'loading' ||
        turnDetailRequestsRef.current.has(requestKey)
      ) {
        return;
      }
      turnDetailRequestsRef.current.add(requestKey);
      setTurnDetailStates((current) => new Map(current).set(detailTaskId, 'loading'));
      try {
        const exact = await dataService.getSubagentThread(
          selection.parentConversationId,
          requestedThreadId,
          detailTaskId,
        );
        if (
          activeThreadRef.current !== requestedThreadId ||
          selectionGenerationRef.current !== requestedGeneration
        ) {
          return;
        }
        if (!subagentThreadHasTaskEvidence(exact, detailTaskId)) {
          setTurnDetailStates((current) => new Map(current).set(detailTaskId, 'unavailable'));
          return;
        }
        const detail = adaptDurableThreadActivity(exact, detailTaskId);
        setTurnDetailOverrides((current) => new Map(current).set(detailTaskId, detail));
        setTurnDetailStates((current) =>
          new Map(current).set(
            detailTaskId,
            detail.activityTruncated === true ? 'unavailable' : 'idle',
          ),
        );
      } catch {
        if (
          activeThreadRef.current !== requestedThreadId ||
          selectionGenerationRef.current !== requestedGeneration
        ) {
          return;
        }
        setTurnDetailStates((current) => new Map(current).set(detailTaskId, 'error'));
      } finally {
        turnDetailRequestsRef.current.delete(requestKey);
      }
    },
    [selection.parentConversationId, threadId, turnDetailStates],
  );
  const loadEarlierHistory = useCallback(async () => {
    const requestedThreadId = threadId;
    const requestedSelectionGeneration = selectionGenerationRef.current;
    const requestedGeneration = historyRebaseActive
      ? (historyCursorGeneration ?? latestHistoryGeneration)
      : latestHistoryGeneration;
    const startsRebase =
      !historyRebaseActive &&
      historyCursor !== undefined &&
      historyCursorGeneration !== requestedGeneration;
    const recoveringRebase = startsRebase || historyRebaseActive;
    const cursor =
      historyCursor === undefined || startsRebase ? threadView?.nextCursor : historyCursor;
    const requestKey = `${requestedSelectionGeneration}\u0000${requestedThreadId}\u0000${cursor ?? ''}\u0000${requestedGeneration}`;
    if (cursor == null || historyState === 'loading' || historyRequestRef.current != null) {
      return;
    }
    historyRequestRef.current = requestKey;
    setHistoryState('loading');
    try {
      const page = await dataService.getSubagentThread(
        selection.parentConversationId,
        requestedThreadId,
        undefined,
        cursor,
      );
      if (
        activeThreadRef.current !== requestedThreadId ||
        selectionGenerationRef.current !== requestedSelectionGeneration
      ) {
        return;
      }
      if (!historyRebaseActive && latestHistoryGenerationRef.current !== requestedGeneration) {
        setHistoryState('idle');
        return;
      }
      const pageTurns = adaptDurableThreadConversation(page);
      let recoveryCompleted = false;
      if (recoveringRebase) {
        const bridgeTurns = startsRebase
          ? retainBoundedMovingWindowTurns(movingWindowTurns, rebaseTurns)
          : movingWindowTurns;
        const nextRebaseTurns = mergeChildConversationTurns(
          pageTurns,
          startsRebase ? [] : rebaseTurns,
        );
        const retainedTaskIds = new Set(
          mergeChildConversationTurns(olderTurns, bridgeTurns, postRebaseTurnsRef.current).map(
            (turn) => turn.taskId,
          ),
        );
        const reconnected = pageTurns.some((turn) => retainedTaskIds.has(turn.taskId));
        const recoveryComplete = reconnected || page.nextCursor == null;
        if (recoveryComplete) {
          recoveryCompleted = true;
          const retainedPostRebaseTurns = postRebaseTurnsRef.current;
          postRebaseTurnsRef.current = [];
          setOlderTurns((current) =>
            mergeChildConversationTurns(
              current,
              bridgeTurns,
              nextRebaseTurns,
              retainedPostRebaseTurns,
            ),
          );
          setMovingWindowTurns([]);
          setRebaseTurns([]);
          setPostRebaseTurns([]);
          setHistoryRebaseActive(false);
          historyRebaseActiveRef.current = false;
        } else {
          if (startsRebase) setMovingWindowTurns(bridgeTurns);
          setRebaseTurns(nextRebaseTurns);
          setHistoryRebaseActive(true);
          historyRebaseActiveRef.current = true;
        }
      } else {
        setOlderTurns((current) => mergeChildConversationTurns(pageTurns, current));
      }
      historyHasLoadedRef.current = true;
      setHistoryCursor(page.nextCursor ?? null);
      setHistoryCursorGeneration(
        recoveryCompleted ? latestHistoryGenerationRef.current : requestedGeneration,
      );
      setHistoryBoundaryUnavailable(
        (current) =>
          current ||
          page.historyUnavailable === true ||
          (page.historyTruncated && page.nextCursor == null),
      );
      setHistoryState('idle');
    } catch {
      if (
        activeThreadRef.current !== requestedThreadId ||
        selectionGenerationRef.current !== requestedSelectionGeneration
      ) {
        return;
      }
      setHistoryState('error');
    } finally {
      if (historyRequestRef.current === requestKey) historyRequestRef.current = null;
    }
  }, [
    threadView?.nextCursor,
    historyCursor,
    historyCursorGeneration,
    historyRebaseActive,
    historyState,
    latestHistoryGeneration,
    movingWindowTurns,
    olderTurns,
    rebaseTurns,
    selection.parentConversationId,
    threadId,
  ]);

  const controlTask = useSubagentControlMutation({
    onSuccess: ({ receipt }, variables) => {
      const submittedSelection = subagentControlStateKey(
        variables.parentConversationId,
        variables.threadId,
        variables.command.taskId,
      );
      setControlStateForIdentity(submittedSelection, { receipt });
      if (controlSelectionRef.current !== submittedSelection) return;
      controlInFlightRef.current = false;
      if (closesTaskControls(receipt)) setControlsClosed(true);
      if (
        variables.command.action !== 'cancel_message' &&
        (receipt.status === 'accepted' || receipt.status === 'applied')
      ) {
        setControlMessage('');
      }
    },
    onError: (error, variables) => {
      const status = responseStatus(error);
      const inaccessible = status === 404;
      const retryable = status == null || status >= 500;
      const command = variables.command;
      const submittedSelection = subagentControlStateKey(
        variables.parentConversationId,
        variables.threadId,
        command.taskId,
      );
      setControlStateForIdentity(submittedSelection, {
        receipt: {
          invocationId: command.invocationId,
          ...(command.controlId == null ? {} : { controlId: command.controlId }),
          action: command.action,
          status: 'failed',
          createdAt: variables.submittedAt,
          updatedAt: new Date().toISOString(),
          ...(command.message == null ? {} : { message: command.message }),
          reason: failedControlReason(inaccessible, retryable),
        },
        ...(retryable ? { retry: command } : {}),
      });
      if (controlSelectionRef.current !== submittedSelection) return;
      controlInFlightRef.current = false;
      if (inaccessible) {
        setControlInaccessible(true);
        setControlsClosed(true);
      }
    },
  });

  useEffect(() => {
    if (transientControl == null) return;
    const durableReceipt = taskView?.controlReceipts?.find(
      (receipt) => receipt.invocationId === transientControl.invocationId,
    );
    if (durableReceipt == null) return;
    /** The durable view is authoritative after refresh. Drop mutation-only state
     * once the same invocation appears there so stale failure/retry UI cannot
     * outlive a successfully persisted receipt. */
    if (
      retryControl != null &&
      retryControl.action !== 'cancel' &&
      retryControl.action !== 'cancel_message' &&
      (durableReceipt.status === 'accepted' || durableReceipt.status === 'applied')
    ) {
      setControlMessage((current) => (current === retryControl.message ? '' : current));
    }
    if (closesTaskControls(durableReceipt)) setControlsClosed(true);
    setControlState(null);
  }, [retryControl, setControlState, taskView?.controlReceipts, transientControl]);

  useEffect(() => {
    if (taskView?.controlReceipts?.some(closesTaskControls)) {
      setControlsClosed(true);
    }
  }, [taskView?.controlReceipts]);

  const submitControl = useCallback(
    (action: SubagentControlAction, controlId?: string, retry?: SubagentControlRequest) => {
      if (
        selection.durable == null ||
        controlTask.isLoading ||
        controlInFlightRef.current ||
        (retryControl != null && retry == null)
      ) {
        return;
      }
      let command: SubagentControlRequest;
      if (retry != null) {
        command = retry;
      } else if (action === 'cancel_message') {
        command = {
          taskId: selection.durable.taskId,
          invocationId: v4(),
          action,
          controlId,
        };
      } else if (action === 'cancel') {
        command = {
          taskId: selection.durable.taskId,
          invocationId: v4(),
          action,
        };
      } else {
        command = {
          taskId: selection.durable.taskId,
          invocationId: v4(),
          action,
          message: controlMessage.trim(),
        };
      }
      if (
        action !== 'cancel' &&
        action !== 'cancel_message' &&
        (command.message == null || command.message === '')
      ) {
        return;
      }
      const now = new Date().toISOString();
      setControlState({
        receipt: {
          invocationId: command.invocationId,
          ...(command.controlId == null ? {} : { controlId: command.controlId }),
          action: command.action,
          status: 'submitted',
          createdAt: now,
          updatedAt: now,
          ...(command.message == null ? {} : { message: command.message }),
        },
        retry: command,
      });
      controlInFlightRef.current = true;
      controlTask.mutate({
        parentConversationId: selection.parentConversationId,
        threadId: selection.durable.threadId,
        command,
        submittedAt: now,
      });
    },
    [
      controlMessage,
      controlTask,
      retryControl,
      selection.durable,
      selection.parentConversationId,
      setControlState,
    ],
  );

  const close = useCallback(() => {
    resetSelection();
    requestAnimationFrame(() => {
      const trigger = Array.from(
        document.querySelectorAll<HTMLElement>('[data-subagent-tool-call]'),
      ).find(
        (element) =>
          element.dataset.subagentToolCall === selection.toolCallId &&
          element.dataset.subagentParentMessage === selection.parentMessageId &&
          element.dataset.subagentPartIndex === String(selection.partIndex),
      );
      trigger?.focus();
    });
  }, [resetSelection, selection.parentMessageId, selection.partIndex, selection.toolCallId]);

  /** Escape is handled on the element rather than through the trap's own
   *  native listener: that listener sits on this `aside`, so it runs BEFORE any
   *  React handler inside it and would close the whole panel out from under a
   *  nested popover that meant to dismiss only itself. As a React handler it
   *  bubbles in DOM order, so an inner control can stop it or mark it handled. */
  useFocusTrap(panelRef, isMobile);
  const handlePanelKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!isMobile || event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      close();
    },
    [close, isMobile],
  );

  useEffect(() => {
    const activeElement = document.activeElement;
    if (!isMobile || !(activeElement instanceof HTMLElement)) return;
    return () => {
      if (activeElement.isConnected) activeElement.focus();
    };
  }, [isMobile]);

  const liveActivity = useMemo(
    () =>
      adaptLivePersistedActivity({
        title: foregroundTitle,
        prompt: selection.prompt,
        progress,
        persistedContent: selection.persistedContent,
        isDetached: selection.durable != null,
        legacyOutput: selection.legacyOutput,
        // A detached parent tool step closes as soon as dispatch succeeds;
        // its terminal status does not describe the still-running child.
        initialProgress: selection.durable == null ? selection.initialProgress : 0,
        isSubmitting: selection.durable == null ? selection.isSubmitting : detachedLiveSubmitting,
        runStepStatus: selection.durable == null ? selection.runStepStatus : undefined,
      }),
    [detachedLiveSubmitting, foregroundTitle, progress, selection],
  );
  const activity = useMemo(() => {
    if (selection.durable == null) return liveActivity;
    if (taskView == null) {
      const activityWithoutData =
        progress == null ? { ...liveActivity, status: 'dispatched' as const } : liveActivity;
      return transientControl == null
        ? activityWithoutData
        : { ...activityWithoutData, controls: [transientControl] };
    }
    const durable = adaptDurableThreadActivity(taskView, selection.durable.taskId);
    const useLiveItems =
      (durable.status === 'running' || durable.status === 'dispatched') &&
      liveActivity.items.length > 0;
    const mergedItems =
      !useLiveItems && durable.items.length > 0 ? durable.items : liveActivity.items;
    const merged = {
      ...durable,
      prompt: durable.prompt ?? liveActivity.prompt,
      items: mergedItems,
    };
    if (
      transientControl == null ||
      (merged.controls ?? []).some(
        (receipt) => receipt.invocationId === transientControl.invocationId,
      )
    ) {
      return merged;
    }
    return { ...merged, controls: [...(merged.controls ?? []), transientControl] };
  }, [liveActivity, progress, selection.durable, taskView, transientControl]);
  const panelTitle = selection.event == null ? activity.title : selectedEventActorName;
  const actorOptions = useMemo<OptionWithIcon[]>(() => {
    if (selection.event == null) return [];
    return (
      eventSiblings
        /** An actor with no task has nothing to open, and this list has no
         *  disabled state — leave it out rather than offering a dead row. The
         *  selected thread stays listed whatever the index currently says. */
        .filter((child) => child.latestTaskId != null || child.threadId === threadId)
        .map((child) => {
          const agent = child.agentId == null ? undefined : agentsMap?.[child.agentId];
          const name = agent?.name || child.actorId || child.title;
          return {
            value: child.threadId,
            label:
              agent?.name != null && child.actorId != null ? `${name} · ${child.actorId}` : name,
            icon: renderAgentAvatar(agent, { size: 'icon', showBorder: false }),
          };
        })
    );
  }, [agentsMap, eventSiblings, selection.event, threadId]);
  const selectedActorLabel =
    actorOptions.find((option) => option.value === threadId)?.label ?? panelTitle;
  const selectedActorAgentId =
    selectedEventActor?.agentId ?? threadView?.agentId ?? foregroundAgentId;
  const selectedActorIcon = renderAgentAvatar(
    selectedActorAgentId == null ? undefined : agentsMap?.[selectedActorAgentId],
    { size: 'icon', showBorder: false },
  );
  const latestConversationTurns = useMemo(
    () => (threadView == null ? [] : adaptDurableThreadConversation(threadView)),
    [threadView],
  );
  const previousLatestTurnsRef = useRef({
    threadId,
    generation: latestHistoryGeneration,
    turns: latestConversationTurns,
  });
  useEffect(() => {
    if (threadView == null) return;
    const previous = previousLatestTurnsRef.current;
    if (previous.threadId === threadId) {
      const latestTaskIds = new Set(latestConversationTurns.map((turn) => turn.taskId));
      const displaced = previous.turns.filter((turn) => !latestTaskIds.has(turn.taskId));
      if (displaced.length > 0 && historyHasLoadedRef.current) {
        if (historyRebaseActiveRef.current) {
          const retained = retainBoundedMovingWindowTurns(postRebaseTurnsRef.current, displaced);
          postRebaseTurnsRef.current = retained;
          setPostRebaseTurns(retained);
        } else {
          setMovingWindowTurns((current) => retainBoundedMovingWindowTurns(current, displaced));
        }
      }
    }
    previousLatestTurnsRef.current = {
      threadId,
      generation: latestHistoryGeneration,
      turns: latestConversationTurns,
    };
  }, [historyRebaseActive, latestConversationTurns, latestHistoryGeneration, threadId, threadView]);
  const retainedTurnsValid = retainedTurnsGenerationRef.current === selectionGenerationRef.current;
  const conversationTurns = useMemo(() => {
    const durableTurns = retainedTurnsValid
      ? mergeChildConversationTurns(
          olderTurns,
          movingWindowTurns,
          rebaseTurns,
          postRebaseTurns,
          latestConversationTurns,
        )
      : mergeChildConversationTurns(latestConversationTurns);
    if (durableTurns.length > 0) {
      const selectedTurnIndex = durableTurns.findIndex((turn) => turn.taskId === taskId);
      if (selectedTurnIndex >= 0) {
        return durableTurns.map((turn, index) => {
          const selected = index === selectedTurnIndex ? { ...turn, activity } : turn;
          const override = turnDetailOverrides.get(turn.taskId);
          return override == null ? selected : { ...selected, activity: override };
        });
      }
      /** A turn absent from the durable window is either the thread's newest
       *  delivery whose fetch has not landed yet (place it at the END, where
       *  it will settle — a new event must not appear at the top and then
       *  jump to the bottom) or an older selection displaced from the bounded
       *  window (keep it ahead of the retained newer continuation). */
      const indexedChild = byThreadId.get(threadId);
      const selectedTaskCreatedAt = indexedChild?.tasks.find(
        (task) => task.taskId === taskId,
      )?.createdAt;
      const synthesizedTurn = {
        taskId: taskId || `${selection.parentMessageId}:${selection.toolCallId}`,
        trigger: {
          kind:
            selection.event == null
              ? ('parent_continuation' as const)
              : ('external_event' as const),
          summary: selection.prompt ?? activity.prompt ?? '',
          ...(selectedTaskCreatedAt == null ? {} : { createdAt: selectedTaskCreatedAt }),
        },
        activity,
      };
      /** Order by trigger time when both sides carry one; the separately
       *  polled discovery index is only the fallback authority, since it can
       *  briefly lag or lead the thread view. */
      const lastDurableCreatedAt = durableTurns[durableTurns.length - 1]?.trigger.createdAt;
      const appendSynthesized =
        selectedTaskCreatedAt != null && lastDurableCreatedAt != null
          ? selectedTaskCreatedAt >= lastDurableCreatedAt
          : indexedChild?.latestTaskId === taskId;
      const retained = appendSynthesized
        ? [...durableTurns, synthesizedTurn]
        : [synthesizedTurn, ...durableTurns];
      return retained.map((turn) => {
        const override = turnDetailOverrides.get(turn.taskId);
        return override == null ? turn : { ...turn, activity: override };
      });
    }
    return [
      {
        taskId: taskId || `${selection.parentMessageId}:${selection.toolCallId}`,
        trigger: {
          kind:
            selection.event == null ? ('parent_dispatch' as const) : ('external_event' as const),
          summary: selection.prompt ?? activity.prompt ?? '',
        },
        activity,
      },
    ];
  }, [
    activity,
    byThreadId,
    latestConversationTurns,
    movingWindowTurns,
    olderTurns,
    postRebaseTurns,
    rebaseTurns,
    retainedTurnsValid,
    threadId,
    selection,
    taskId,
    turnDetailOverrides,
  ]);
  const effectiveTurnDetailStates = useMemo(() => {
    const states = new Map(turnDetailStates);
    if (activity.activityTruncated === true && taskId !== '') states.set(taskId, 'unavailable');
    return states;
  }, [activity.activityTruncated, taskId, turnDetailStates]);
  const historyCursorUsesLatest =
    !historyRebaseActive &&
    (historyCursor === undefined || historyCursorGeneration !== latestHistoryGeneration);
  const effectiveHistoryCursor = historyCursorUsesLatest ? threadView?.nextCursor : historyCursor;
  const showUnavailableHistoryBoundary =
    historyBoundaryUnavailable ||
    threadView?.historyUnavailable === true ||
    (historyCursorUsesLatest &&
      threadView?.historyTruncated === true &&
      threadView.nextCursor == null);
  /** During a rolling deployment an older API replica can omit `turns`. Keep
   * that response readable through the same deep activity renderer; every
   * current host otherwise enters the conversation-native rendering seam. */
  const hasConversationProjection =
    selection.durable == null || threadView == null || Array.isArray(threadView.turns);
  const taskInaccessible = controlInaccessible || transientControl?.reason === 'task_inaccessible';
  const taskIsLive = taskView != null && isLiveSubagentStatus(taskView.status);
  /** A command can only be addressed once the task has a durable input row or a
   *  live lease — `control.ts` answers 404 otherwise, which this panel reads as
   *  an inaccessible task and closes its controls for good. A `dispatched` task
   *  without that evidence is live but not yet controllable: the composer stays
   *  (withdrawing it as a run starts is the swap this panel exists to avoid),
   *  while submission waits. */
  const controlAddressable =
    taskView != null &&
    (taskView.status === 'running' ||
      (taskView.status === 'dispatched' && subagentThreadHasTaskEvidence(taskView, taskId)));
  const controlAvailable =
    selection.durable != null && controlAddressable && !taskInaccessible && !controlsClosed;
  const controlPending =
    controlTask.isLoading || transientControl?.status === 'submitted' || retryControl != null;
  const showControlFooter =
    controlAvailable || retryControl != null || transientControl?.reason === 'task_inaccessible';
  const canContinueAsChat =
    selection.host === 'conversation' &&
    selection.durable != null &&
    taskView?.subagentKind === 'agent' &&
    taskView.agentId != null &&
    taskView.status === 'completed' &&
    subagentThreadHasTaskEvidence(taskView, taskId) &&
    taskView.messages.some((message) => message.messageId === `${taskId}:assistant`);

  const continueAsChat = useCallback(() => {
    if (!canContinueAsChat || selection.durable == null || continueChat.isLoading) return;
    continuationRef.current = { identity: controlIdentity, text: controlMessage.trim() };
    setContinuationPending(true);
    continueChat.mutate({
      conversationId: selection.durable.threadId,
      messageId: `${selection.durable.taskId}:assistant`,
      option: ForkOptions.DIRECT_PATH,
    });
  }, [canContinueAsChat, continueChat, controlIdentity, controlMessage, selection.durable]);
  /** `control` steers the live run, `continue` carries the thread into a chat
   *  of the reader's own. Both compose into the same field, with the same
   *  placeholder the main chat composer shows for this agent. */
  let liveComposerMode: 'control' | 'continue' | null = null;
  if (controlAvailable) {
    liveComposerMode = 'control';
  } else if (canContinueAsChat) {
    liveComposerMode = 'continue';
  }
  /** A delivery re-keys the query to its new task, and the task view blanks for
   *  the render or two that takes — deliberately, so task-scoped fields are
   *  never attributed to the wrong task. Presence must not follow it down: the
   *  composer would unmount and remount within the same tenth of a second,
   *  taking focus and the reader's half-typed words with it. The last mode this
   *  thread showed carries the surface across that gap, holding submission
   *  until the new task's own view arrives. */
  const retainedModeRef = useRef<{ threadId: string; mode: 'control' | 'continue' } | null>(null);
  if (liveComposerMode != null) {
    retainedModeRef.current = { threadId, mode: liveComposerMode };
  } else if (retainedModeRef.current != null && retainedModeRef.current.threadId !== threadId) {
    retainedModeRef.current = null;
  }
  /** Hold the surface both while a delivery re-keys the view and while a live
   *  task is not yet addressable; submission waits in either case. A task whose
   *  controls are definitively closed holds nothing — there is no command left
   *  for the field to carry. */
  const composerSettling =
    liveComposerMode == null &&
    (taskView == null || (taskIsLive && !controlsClosed && !taskInaccessible));
  /** While settling, the surface the thread last showed — or, on a first render
   *  that has never had one, the surface a live task would have. */
  let composerMode: 'control' | 'continue' | null = liveComposerMode;
  if (composerMode == null && composerSettling) {
    composerMode = retainedModeRef.current?.mode ?? (taskIsLive ? 'control' : null);
  }
  const actionsInline = coarsePointer || isMobile;
  const composerPlaceholder = localize('com_endpoint_message_new', { 0: panelTitle });
  /** The send control names what IT does, distinct from the `Steer` row it
   *  offers — the same pairing main chat uses for its during-run send. */
  const composerSubmitLabel =
    composerMode === 'control'
      ? localize('com_ui_steer_send')
      : localize('com_ui_subagent_continue_new_chat');
  const cancelTask = useCallback(() => submitControl('cancel'), [submitControl]);
  /** Handler and label travel as one value, so the Stop control can never
   *  render without an accessible name. */
  const stopProps: ComposerStopProps =
    controlAvailable && !controlPending
      ? { onStop: cancelTask, stopLabel: localize('com_ui_subagent_cancel_task') }
      : {};
  const controlModeRef = useRef(false);
  const chordControlRef = useRef<{
    event: ReactKeyboardEvent<HTMLTextAreaElement>;
    control: SubagentControlAction;
  } | null>(null);
  controlModeRef.current = composerMode === 'control';
  let composerCanSubmit: boolean;
  if (composerSettling) {
    composerCanSubmit = false;
  } else if (composerMode === 'control') {
    composerCanSubmit = !controlPending && controlMessage.trim() !== '';
  } else {
    composerCanSubmit = !continueChat.isLoading;
  }
  /** The alternate submissions, offered from the send control exactly as main
   *  chat offers its during-run actions — never as a row of controls beside the
   *  field repeating what submitting already does. Each chord is advertised
   *  only while it still reaches its action, read from the same decision table
   *  that will execute it. */
  const submitActions = useMemo<SendAction[]>(() => {
    if (composerMode !== 'control') return [];
    const context = {
      isComposing: false,
      isSubmitting: true,
      allowSubmitWhileGenerating: true,
      hasDuringRunModifier: true,
      shortcutsEnabled,
      enterToSend,
      submitOverride,
      yieldedChords,
    };
    const base = { key: 'Enter', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    const plainEnter = resolveComposerKeyDown(base, context);
    const modEnter = resolveComposerKeyDown(
      { ...base, ctrlKey: !isMacPlatform, metaKey: isMacPlatform },
      context,
    );
    const altEnter = resolveComposerKeyDown({ ...base, altKey: true }, context);
    const modSymbol = isMacPlatform ? '\u2318\u23CE' : 'Ctrl \u23CE';
    const altSymbol = isMacPlatform ? '\u2325\u23CE' : 'Alt \u23CE';
    let steerKbd: string | undefined;
    if (plainEnter === 'submit') {
      steerKbd = '\u23CE';
    } else if (modEnter === 'submit') {
      steerKbd = modSymbol;
    }
    /** The same gate the send button answers to: a retained surface over a task
     *  the server cannot address yet must not offer a command through any of
     *  its doors — every 404 here closes this task's controls for good. */
    const blocked = !controlAvailable || controlPending || controlMessage.trim() === '';
    return [
      {
        key: 'steer',
        label: localize('com_ui_steer'),
        kbd: steerKbd,
        icon: <Zap className="h-4 w-4 text-status-warning" aria-hidden="true" />,
        disabled: blocked,
        onClick: () => submitControl('steer'),
      },
      {
        key: 'queue',
        label: localize('com_ui_queue'),
        kbd: modEnter === 'other' ? modSymbol : undefined,
        icon: <Clock className="h-4 w-4 text-status-info" aria-hidden="true" />,
        disabled: blocked,
        onClick: () => submitControl('queue'),
      },
      {
        key: 'interrupt',
        label: localize('com_ui_subagent_interrupt'),
        kbd: altEnter === 'interrupt' ? altSymbol : undefined,
        icon: <OctagonPause className="h-4 w-4 text-status-error" aria-hidden="true" />,
        disabled: blocked,
        onClick: () => submitControl('interrupt'),
      },
    ];
  }, [
    composerMode,
    controlAvailable,
    controlMessage,
    controlPending,
    enterToSend,
    localize,
    shortcutsEnabled,
    submitControl,
    submitOverride,
    yieldedChords,
  ]);
  /** The main chat form's own Enter decision table, so a reader who rebound or
   *  unbound the submit shortcut gets the same contract here, and chords
   *  claimed by global shortcuts are left for the window handler. */
  const resolveKeyVerdict = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>, isComposing: boolean): ComposerKeyVerdict => {
      /** A live run is exactly the condition main chat calls "during run", so
       *  its during-run chords carry over verbatim: the default submits a
       *  steer, ⌘/Ctrl+Enter takes the other queueing action, and the
       *  interrupting chords interrupt. */
      const duringRun = controlModeRef.current;
      const action = resolveComposerKeyDown(event, {
        isComposing,
        isSubmitting: duringRun,
        allowSubmitWhileGenerating: duringRun,
        hasDuringRunModifier: duringRun,
        shortcutsEnabled,
        enterToSend,
        submitOverride,
        yieldedChords,
      });
      const control = CONTROL_FOR_ACTION[action as keyof typeof CONTROL_FOR_ACTION];
      if (control != null) {
        /** Bound to THIS event, so a chord the composer then refuses leaves
         *  nothing a later pointer click could pick up. */
        chordControlRef.current = { event, control };
        return 'submit';
      }
      if (action === 'newline') return 'newline';
      if (action === 'block') return 'block';
      return 'none';
    },
    [enterToSend, shortcutsEnabled, submitOverride, yieldedChords],
  );
  /** The submitting event decides which control this is, so a chord that was
   *  refused (empty field, settling, a command already in flight) leaves
   *  nothing behind for the next pointer click to pick up. */
  const submitComposer = useCallback(
    (event?: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (!controlAvailable) {
        continueAsChat();
        return;
      }
      const chord = chordControlRef.current;
      chordControlRef.current = null;
      submitControl(event != null && chord?.event === event ? chord.control : 'steer');
    },
    [continueAsChat, controlAvailable, submitControl],
  );
  const selectActor = useCallback(
    (nextThreadId: string) => {
      const next = eventSiblings.find((child) => child.threadId === nextThreadId);
      if (next == null) return;
      const nextSelection = eventSubagentSelection(
        selection.parentConversationId,
        next,
        selection.event?.siblingParentMessageIds,
      );
      if (nextSelection != null) setSelection(nextSelection);
    },
    [
      eventSiblings,
      selection.event?.siblingParentMessageIds,
      selection.parentConversationId,
      setSelection,
    ],
  );
  let panelState: 'ready' | 'loading' | 'error' = 'ready';
  if (
    selection.durable != null &&
    liveActivity.items.length === 0 &&
    (isLoading || isReadinessPending)
  ) {
    panelState = 'loading';
  } else if (selection.durable != null && liveActivity.items.length === 0 && isError) {
    panelState = 'error';
  }
  const renderEventTask = (task: ParentSubagentTaskSummary) => {
    if (task.taskId === taskId) {
      return (
        <SubagentActivity
          key={task.taskId}
          activityId={`${selection.parentMessageId}\u0000${selection.toolCallId}\u0000${task.taskId}`}
          activity={activity}
          state={panelState}
          embedded
          onCancelControl={
            controlAvailable && !controlPending
              ? (controlId) => submitControl('cancel_message', controlId)
              : undefined
          }
        />
      );
    }
    return (
      <HistoricalEventTaskActivity
        key={task.taskId}
        selection={selection}
        task={task}
        title={activity.title}
      />
    );
  };
  const loadEarlierEventTasks = () => {
    setEventTaskWindow({
      threadId,
      count: Math.min(eventTaskCount, visibleEventTaskCount + EVENT_TASK_PAGE_SIZE),
      taskCount: eventTaskCount,
    });
  };
  let timelinePrefix: ReactNode = null;
  if (hasEarlierRetainedTasks) {
    timelinePrefix = (
      <div className="flex justify-center border-b border-border-light px-4 py-2">
        <Button type="button" variant="ghost" size="sm" onClick={loadEarlierEventTasks}>
          {localize('com_ui_load_more')}
        </Button>
      </div>
    );
  } else if (eventSummary?.tasksTruncated === true) {
    timelinePrefix = (
      <div
        role="status"
        aria-label={localize('com_ui_subagent_thread_history_truncated')}
        className="flex h-7 items-center justify-center border-b border-border-light text-text-tertiary"
      >
        <span aria-hidden>•••</span>
      </div>
    );
  }
  const conversationStateByTask = useMemo(
    () => new Map([[taskId || conversationTurns[0]?.taskId || '', panelState] as const]),
    [conversationTurns, panelState, taskId],
  );

  let activityPanel: ReactNode;
  if (hasConversationProjection) {
    activityPanel = (
      <SubagentActivityScrollSurface padded={false} headerInset>
        {showUnavailableHistoryBoundary && (
          <div
            role="status"
            aria-label={localize('com_ui_subagent_thread_history_truncated')}
            className="flex h-7 items-center justify-center border-b border-border-light text-text-tertiary"
          >
            <span aria-hidden>•••</span>
          </div>
        )}
        {effectiveHistoryCursor != null && historyState !== 'error' && (
          <div className="flex justify-center border-b border-border-light px-4 py-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={historyState === 'loading'}
              onClick={() => void loadEarlierHistory()}
            >
              {historyState === 'loading'
                ? localize('com_ui_loading')
                : localize('com_ui_subagent_load_earlier_activity')}
            </Button>
          </div>
        )}
        {historyState === 'error' && (
          <div className="flex justify-center border-b border-border-light px-4 py-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void loadEarlierHistory()}
            >
              {localize('com_ui_retry')}
            </Button>
          </div>
        )}
        <SubagentConversation
          turns={conversationTurns}
          agentId={threadView?.agentId}
          conversationId={threadId || selection.parentConversationId}
          stateByTask={conversationStateByTask}
          controllableTaskId={
            controlAvailable && !controlPending ? selection.durable?.taskId : undefined
          }
          onCancelControl={(_controlledTaskId, controlId) =>
            submitControl('cancel_message', controlId)
          }
          detailStateByTask={effectiveTurnDetailStates}
          onLoadTurnDetails={loadTurnDetails}
        />
      </SubagentActivityScrollSurface>
    );
  } else if (
    selection.event != null &&
    ((eventSummary?.tasks.length ?? 0) > 1 || eventSummary?.tasksTruncated === true)
  ) {
    activityPanel = (
      <SubagentActivityScrollSurface padded={false} headerInset>
        <div data-subagent-thread-timeline>
          {timelinePrefix}
          {visibleEventTasks.map(renderEventTask)}
        </div>
      </SubagentActivityScrollSurface>
    );
  } else {
    activityPanel = (
      <SubagentActivity
        key={`${selection.parentMessageId}\u0000${selection.toolCallId}\u0000${selection.partIndex}`}
        activityId={`${selection.parentMessageId}\u0000${selection.toolCallId}\u0000${selection.partIndex}`}
        activity={activity}
        state={panelState}
        showPrompt={false}
        headerInset
        onCancelControl={
          controlAvailable && !controlPending
            ? (controlId) => submitControl('cancel_message', controlId)
            : undefined
        }
      />
    );
  }

  const panel = (
    <aside
      ref={panelRef}
      role={isMobile ? 'dialog' : 'region'}
      aria-modal={isMobile || undefined}
      aria-label={localize('com_ui_subagent_thread_panel')}
      onKeyDown={handlePanelKeyDown}
      className="relative flex h-full w-full flex-col overflow-hidden bg-surface-primary-alt text-text-primary"
    >
      {/* The main chat header's own shape: a 52px bar that floats over the
          thread and fades into it, so the conversation scrolls under it and
          more of it is on screen. Gradient stops track THIS surface rather
          than the chat's, since the panel sits on its own background. */}
      <header className="absolute top-0 z-10 flex h-[52px] w-full items-center gap-2 bg-gradient-to-b from-surface-primary-alt via-surface-primary-alt/70 to-transparent p-2 font-semibold text-text-primary">
        {actorOptions.length > 1 ? (
          /* The agent builder's picker, so switching actors here reads as the
             same control as every other agent selection in the app — avatar,
             searchable list, and the shared theming that comes with it.

             The wrapper keeps an Escape aimed at the open popover from reaching
             the panel's focus trap, which closes the whole panel on Escape and
             would take the composer's text with it. */
          <div
            className="flex min-w-0 flex-1"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && actorPickerOpen) event.stopPropagation();
            }}
          >
            <ControlCombobox
              isCollapsed={false}
              selectedValue={threadId}
              setValue={selectActor}
              displayValue={selectedActorLabel}
              selectPlaceholder={selectedActorLabel}
              searchPlaceholder={localize('com_agents_search_name')}
              ariaLabel={localize('com_ui_subagent_actor')}
              items={actorOptions}
              SelectIcon={selectedActorIcon}
              disabled={continuationPending}
              /** In the panel, not in a portal: on mobile this `aside` is a
                  modal whose focus trap only knows its own descendants, so a
                  portaled search field would let Tab escape to the page
                  behind it. */
              portal={false}
              onOpenChange={setActorPickerOpen}
              containerClassName="min-w-0 flex-1 px-0"
              className="h-9 w-full border-transparent bg-transparent font-semibold hover:bg-surface-hover"
              showCarat
            />
          </div>
        ) : (
          <>
            {/* The `MessageRow` author-glyph slot, one size up: no plate
                behind it, so an agent avatar reads as the avatar it is. */}
            <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full">
              {selectedActorIcon}
            </div>
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={panelTitle}>
              {panelTitle}
            </h2>
          </>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={close}
          aria-label={localize('com_ui_close')}
          className="h-8 w-8 shrink-0"
        >
          <X size={17} aria-hidden="true" />
        </Button>
      </header>

      {/* Keep the foreground panel's existing nested-tool approval controls
          coordinated within this invocation. Detached activity projections
          never include approval payloads. */}
      <ApprovalProvider
        key={`${selection.parentMessageId}\u0000${selection.toolCallId}\u0000${selection.partIndex}`}
      >
        {activityPanel}
      </ApprovalProvider>
      {(showControlFooter || composerMode != null) && (
        /* The main chat form's own bottom rhythm, read from the same answer it
           reads (`useConfiguredFooter`): a conversation clears the footer bar
           when the deployment configured one and otherwise keeps only enough to
           show the composer's shadow, and this surface keeps the same, so the
           two end on one line when the panel is open beside the thread. */
        <div className={cn('shrink-0 px-3 pt-2', clearsFooter ? 'pb-10' : 'pb-4')}>
          {transientControl?.status === 'failed' && (
            <Alert variant="error" className="mb-2 flex items-center gap-2">
              <span className="min-w-0 flex-1">
                {localize(failedControlLocaleKey(transientControl.reason))}
              </span>
              {retryControl != null && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={controlTask.isLoading}
                  onClick={() =>
                    submitControl(retryControl.action, retryControl.controlId, retryControl)
                  }
                >
                  {localize('com_ui_retry')}
                </Button>
              )}
            </Alert>
          )}
          {composerMode != null && (
            /* One surface across the run's whole life, and one control on it:
               submitting IS the steer, with nothing to send the send button
               becomes main chat's Stop, and every alternate submission hangs
               off that same control the way main chat's during-run actions do. */
            <Composer
              value={controlMessage}
              onChange={setControlMessage}
              onSubmit={submitComposer}
              canSubmit={composerCanSubmit}
              disabled={composerMode === 'control' && controlPending}
              submitLabel={composerSubmitLabel}
              {...stopProps}
              ariaLabel={localize('com_ui_message_input')}
              placeholder={composerPlaceholder}
              submitOnEnter={enterToSend}
              resolveKeyVerdict={resolveKeyVerdict}
              /** The cap bounds a subagent CONTROL command's payload. A
               *  continuation is ordinary chat text bound for an ordinary
               *  composer, which caps nothing. */
              maxLength={composerMode === 'control' ? 4 * 1024 : undefined}
              submitActions={actionsInline ? [] : submitActions}
              submitActionsLabel={localize('com_ui_during_run_actions')}
              actions={
                actionsInline
                  ? submitActions
                      .filter((action) => action.key !== 'steer')
                      .map((action) => (
                        <Button
                          key={action.key}
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={action.label}
                          disabled={action.disabled}
                          onClick={action.onClick}
                          className="size-9 rounded-full text-text-secondary hover:text-text-primary"
                        >
                          {action.icon}
                        </Button>
                      ))
                  : null
              }
            />
          )}
        </div>
      )}
    </aside>
  );
  return (
    <OverlayBack open={isMobile} onClose={close}>
      {panel}
    </OverlayBack>
  );
}

function HistoricalEventTaskActivity({
  selection,
  task,
  title,
}: {
  selection: ActiveSubagentPanel;
  task: ParentSubagentTaskSummary;
  title: string;
}) {
  const threadId = selection.durable?.threadId ?? '';
  const { data, isLoading, isError, isReadinessPending } = useSubagentThreadQuery(
    selection.parentConversationId,
    threadId,
    task.taskId,
  );
  const activity = useMemo(
    () =>
      data == null
        ? { title, status: task.status, items: [], controls: [] }
        : adaptDurableThreadActivity(data, task.taskId),
    [data, task.status, task.taskId, title],
  );
  let state: 'ready' | 'loading' | 'error' = 'ready';
  if (isError) {
    state = 'error';
  } else if (isLoading || isReadinessPending) {
    state = 'loading';
  }

  return (
    <SubagentActivity
      activityId={`${selection.parentMessageId}\u0000${selection.toolCallId}\u0000${task.taskId}`}
      activity={activity}
      state={state}
      showPrompt={false}
      embedded
    />
  );
}

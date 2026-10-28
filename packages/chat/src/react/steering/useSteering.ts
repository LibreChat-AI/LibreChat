import { useCallback, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import {
  Constants,
  isAgentsEndpoint,
  isAssistantsEndpoint,
  DEFAULT_QUEUED_SEND_LOCK_TIMEOUT_MS,
} from 'librechat-data-provider';
import type { TMessage, TConversation, CodeEnvironmentMode } from 'librechat-data-provider';
import type {
  SubmitSteerOptions,
  QueuedMessageContext,
  QueuedMessageOrigin,
  PendingSteer,
  DuringRunAction,
} from '../../core';
import type { ComposerFile, ComposerFileSetter } from './types';
import type { DuringRunActions } from './actions';
import type { QueuedRecovery } from './recovery';
import type { QueueEnqueue } from './enqueue';
import type { SubmitSteer } from './submit';
import type { QueuedSend } from './send';
import type { QueueRows } from './rows';
import {
  revealedQueuedTurnFamily,
  pendingSteersByConvoId,
  activeGenerationCreatedAtByConvoId,
  activeGenerationProtocolVersionByConvoId,
} from '../steer/atoms';
import { hasLiveRunPause, selectLiveMessageState, carriedSteerContext } from '../../core';
import { getReasoningStateKey, pendingReasoningOverrideFamily } from '../composer';
import useQueuedTurnReceipts from './receipts';
import { useSteerHost } from '../steer/host';
import useDuringRunActions from './actions';
import useQueuedRecovery from './recovery';
import useComposerTake from './composer';
import useQueueEnqueue from './enqueue';
import useSubmitSteer from './submit';
import useSteerChips from './chips';
import useQueuedSend from './send';
import useQueueRows from './rows';

export interface UseSteeringParams<File extends ComposerFile = ComposerFile> {
  /** Consume the actual storage key selected by the composer’s autosave owner. */
  consumeDraft: () => void;
  index: number;
  conversationId: string;
  conversation: TConversation | null;
  addedConversation?: TConversation | null;
  /** The workspace mode the composer resolved for the next turn. */
  codeEnvironmentMode?: CodeEnvironmentMode;
  isSubmitting: boolean;
  answerModeActive: boolean;
  /** Host-owned preparation hold; existing queued-message and Stop actions remain independent. */
  composerDisabled?: boolean;
  /** Composer attachments: consumed into queued items (steering is text-only). */
  files?: Map<string, File>;
  setFiles?: ComposerFileSetter<File>;
  /** Uploads still in flight: during-run submits are held like the send button. */
  filesLoading?: boolean;
  /** Submits text (and optional attachments/quotes/skills) as a normal new
   *  turn. Overrides are always explicit; a queued item is the FULL
   *  submission context, so absent fields must send as empty, never vacuum
   *  the composer. Returns `false` when `ask` refused without sending
   *  (in-flight guard, history not cached yet) so callers can restore
   *  instead of dropping. */
  sendNow: (
    text: string,
    files?: TMessage['files'],
    context?: QueuedMessageContext,
  ) => false | void;
  /** Stops the current generation (used by interrupt & send). */
  stopGenerating: () => void;
}

/** What the composer, the queue rail and the pending steers drive a run's steering through. */
export interface SteeringControls {
  enabled: boolean;
  queueKey: string;
  canSteer: boolean;
  canControlGeneration: boolean;
  duringRunActive: boolean;
  canSendQueuedNow: boolean;
  effectiveAction: DuringRunAction;
  defaultAction: DuringRunAction;
  pendingReasoningOverride: TMessage['reasoningOverride'];
  pausedOnApproval: boolean;
  setDefaultAction: (action: DuringRunAction) => void;
  submitDuringRun: DuringRunActions['submitDuringRun'];
  steerFromComposer: DuringRunActions['steerFromComposer'];
  queueFromComposer: DuringRunActions['queueFromComposer'];
  submitSteer: SubmitSteer;
  retrySteer: (
    steerId: string,
    text: string,
    steerFiles?: TMessage['files'],
    context?: QueuedMessageContext,
    opts?: SubmitSteerOptions,
  ) => void;
  removeSteer: (steerId: string) => void;
  convertSteerToQueue: (
    steerId: string,
    text: string,
    steerFiles?: TMessage['files'],
    context?: QueuedMessageContext,
    queuedOrigin?: QueuedMessageOrigin,
  ) => void;
  queueReclaimedSteer: (steer: PendingSteer) => void;
  enqueue: QueueEnqueue['enqueue'];
  removeQueued: QueueRows['removeQueued'];
  holdQueued: QueueRows['holdQueued'];
  toggleQueuedHold: QueueRows['toggleQueuedHold'];
  discardQueued: QueuedRecovery['discardQueued'];
  dismissRecovery: QueuedRecovery['dismissRecovery'];
  rewakeDrain: QueueRows['rewakeDrain'];
  reorderQueued: QueueRows['reorderQueued'];
  restoreQueuedOrder: QueueRows['restoreQueuedOrder'];
  sendQueuedNow: QueuedSend['sendQueuedNow'];
  interruptAndSend: DuringRunActions['interruptAndSend'];
  interruptSteer: DuringRunActions['interruptSteer'];
}

/**
 * The composer's during-run brain: decides what Enter does while a run is
 * generating (steer vs queue, per the user preference and run state), owns the
 * pending-steer / queued-message chip state, and implements the three actions:
 * steer (POST + optimistic chip), queue (client-side), and interrupt & send
 * (abort, then auto-send via the one-shot drain override).
 */
export default function useSteering<File extends ComposerFile = ComposerFile>({
  consumeDraft: takeComposerDraft,
  index,
  conversationId,
  conversation,
  addedConversation,
  codeEnvironmentMode,
  isSubmitting,
  answerModeActive,
  composerDisabled = false,
  files,
  setFiles,
  filesLoading = false,
  sendNow,
  stopGenerating,
}: UseSteeringParams<File>): SteeringControls {
  const composerDisabledRef = useRef(composerDisabled);
  composerDisabledRef.current = composerDisabled;
  const host = useSteerHost();
  const {
    queuedSendLockTimeoutMs,
    duringRunDefaultAction: defaultAction,
    setDuringRunDefaultAction: setDefaultAction,
  } = host.useSettings();

  const codeApprovalMode = host.useCodeApprovalMode(
    conversation,
    addedConversation,
    codeEnvironmentMode,
  );
  const endpoint = conversation?.endpointType ?? conversation?.endpoint;
  const steerable = !isAssistantsEndpoint(endpoint);
  const hasRealConvoId =
    conversationId != null && conversationId !== '' && conversationId !== Constants.NEW_CONVO;
  const serverQueueEnabled = isAgentsEndpoint(endpoint) && hasRealConvoId;
  /** v1 gates the during-run UI to the primary composer, like the HITL popover. */
  const enabled = steerable && index === 0;
  const queueKey = hasRealConvoId ? conversationId : Constants.NEW_CONVO;
  const reasoningStateKey = getReasoningStateKey(conversationId, index);
  const sendLockTimeoutMs = queuedSendLockTimeoutMs ?? DEFAULT_QUEUED_SEND_LOCK_TIMEOUT_MS;
  const pendingReasoningOverride = useAtomValue(pendingReasoningOverrideFamily(reasoningStateKey));
  const { applyQueuedTurnReceipts, finishQueuedTurnEnqueue } = useQueuedTurnReceipts({
    conversationId,
    queueKey,
    serverQueueEnabled,
  });
  /** Retain admission ownership through history hydration and stream attach;
   * ordinary sends must not overtake the server-owned successor. */
  const pendingReveal = useAtomValue(revealedQueuedTurnFamily(queueKey));
  const revealPending = pendingReveal != null;
  const activeGenerationCreatedAt = useAtomValue(activeGenerationCreatedAtByConvoId(queueKey));
  const activeGenerationProtocolVersion = useAtomValue(
    activeGenerationProtocolVersionByConvoId(queueKey),
  );

  /** The start POST installs this epoch before any live mutation may be sent.
   * `isSubmitting` flips earlier so the user can keep typing; during that
   * bounded interval submits degrade to the local queue and Stop/steer refuse. */
  const canControlGeneration = activeGenerationCreatedAt != null;
  const duringRunActive = enabled && (isSubmitting || revealPending) && !answerModeActive;
  const pendingSteers = useAtomValue(pendingSteersByConvoId(queueKey));

  const rows = useQueueRows({
    index,
    queueKey,
    conversationId,
    isSubmitting,
    pendingSteers,
    activeGenerationCreatedAt,
  });
  const {
    updateQueuedMessage,
    removeQueued,
    holdQueued,
    toggleQueuedHold,
    downgradeServerQueuedTurn,
    reorderQueued,
    restoreQueuedOrder,
    restoreQueued,
    rewakeDrain,
    armDrainAfterAbort,
  } = rows;
  /** Capture a durable branch anchor into a server queued turn. Optimistic
   * assistant placeholders are siblings of their eventual persisted response,
   * so they anchor through their stable user parent. */
  const latestMessage = host.useLatestMessage(index, hasRealConvoId ? conversationId : null);
  const liveMessageState = useMemo(() => selectLiveMessageState(latestMessage), [latestMessage]);
  /** Both approval cards and `ask_user_question` suspend the current
   * generation while keeping its submission slot occupied. Answer mode hides
   * the ordinary during-run composer, but waiting-message controls still need
   * to know a live generation exists so they remain discoverable and disabled
   * instead of looking as though the action disappeared. */
  const pausedOnApproval =
    enabled && isSubmitting ? answerModeActive || hasLiveRunPause(latestMessage) : false;
  const canSteer = hasRealConvoId && canControlGeneration && !pausedOnApproval;
  const canSendQueuedNow = (!isSubmitting && !revealPending) || (duringRunActive && canSteer);

  /** A live steer cannot change the provider request already in flight.
   * Stage a full queued turn instead, and expose that same effective action to
   * Enter, the button and the hint. */
  const effectiveAction: DuringRunAction =
    canSteer && pendingReasoningOverride == null ? defaultAction : 'queue';
  /** Live submission state for POST callbacks: the closure value can be
   *  stale by the time the steer response arrives. */
  const isSubmittingRef = useRef(isSubmitting);
  isSubmittingRef.current = isSubmitting;
  const visibleConversationRef = useRef(conversationId);
  visibleConversationRef.current = conversationId;

  const chips = useSteerChips({ visibleConversationRef, isSubmittingRef });
  const { replaceSteerChip } = chips;
  const { enqueue } = useQueueEnqueue({
    queueKey,
    conversationId,
    serverQueueEnabled,
    codeApprovalMode,
    liveParentMessageId: liveMessageState?.parentMessageId,
    pendingReveal,
    activeGenerationCreatedAt,
    applyQueuedTurnReceipts,
    finishQueuedTurnEnqueue,
    updateQueuedMessage,
  });
  const { discardQueued, dismissRecovery } = useQueuedRecovery({
    queueKey,
    conversationId,
    hasRealConvoId,
    applyQueuedTurnReceipts,
    downgradeServerQueuedTurn,
    removeQueued,
  });
  const composer = useComposerTake({
    conversationId,
    reasoningStateKey,
    files,
    setFiles,
  });

  const submitSteer = useSubmitSteer({
    conversationId,
    hasRealConvoId,
    activeGenerationCreatedAt,
    activeGenerationProtocolVersion,
    visibleConversationRef,
    isSubmittingRef,
    sendNow,
    chips,
    rows,
    enqueue,
  });

  /** Retry a failed chip through the normal steer path. */
  const retrySteer = useCallback(
    (
      steerId: string,
      text: string,
      steerFiles?: TMessage['files'],
      context?: QueuedMessageContext,
      opts?: SubmitSteerOptions,
    ) => {
      /** A failed interrupt-steer must retry AS an interrupt; resubmitting it
       *  as an ordinary steer would silently let generation run on. */
      submitSteer(text, steerFiles, context, {
        ...opts,
        clientSteerId: steerId,
      });
    },
    [submitSteer],
  );

  const removeSteer = useCallback(
    (steerId: string) => {
      replaceSteerChip(conversationId, steerId, null);
    },
    [conversationId, replaceSteerChip],
  );

  /**
   * Re-homes a steer the client just reclaimed from the server queue (see
   * `useSteerReclaim`) as a queued follow-up.
   *
   * Routed through the shared conversion rather than `enqueue` so it obeys the
   * same invariant as the leftover-steer path: the item keeps its ORIGINAL id
   * and `createdAt`, so a steer accepted before a later follow-up still drains
   * ahead of it; a fresh `Date.now()` would sort it last.
   *
   * The reclaim is a round-trip, so the run can end while it is in flight and
   * the drain can consume its one-shot run-end signal against an empty queue,
   * leaving nothing to auto-send this item. Rather than send it here, re-post
   * that spent signal so `useQueueDrain` runs again and decides: it owns the
   * completed-only rule, FIFO order, `NEW_CONVO` migration, and submitting via
   * `ask` (which, unlike the composer's `sendNow`, does not reset the form and
   * so cannot wipe a draft typed while the reclaim was in flight).
   *
   * Parked under the conversation rather than the index, so a run that ended
   * while the user was elsewhere still drains when they come back.
   */
  const queueReclaimedSteer = useCallback(
    (steer: PendingSteer) => {
      // A confirmed cancel has no parked server source. Restore one ordinary
      // queue item explicitly (the reclaim tombstone intentionally makes the
      // shared terminal converter ignore late payloads for these ids).
      if (steer.queuedOrigin != null) {
        restoreQueued(steer.queuedOrigin);
      } else {
        enqueue(steer.text, {
          id: steer.steerId,
          createdAt: steer.createdAt,
          files: steer.files,
          ...carriedSteerContext(steer),
          skipUsageMark: true,
        });
      }
      rewakeDrain(conversationId);
    },
    [conversationId, enqueue, rewakeDrain, restoreQueued],
  );

  /** Convert a failed/unsent steer chip into a queued follow-up. */
  const convertSteerToQueue = useCallback(
    (
      steerId: string,
      text: string,
      steerFiles?: TMessage['files'],
      context?: QueuedMessageContext,
      queuedOrigin?: QueuedMessageOrigin,
    ) => {
      replaceSteerChip(conversationId, steerId, null);
      if (queuedOrigin != null) {
        restoreQueued(queuedOrigin);
        return;
      }
      enqueue(text, { files: steerFiles, ...context });
    },
    [conversationId, replaceSteerChip, restoreQueued, enqueue],
  );

  const { sendQueuedNow } = useQueuedSend({
    index,
    queueKey,
    isSubmitting,
    duringRunActive,
    canSteer,
    sendLockTimeoutMs,
    sendNow,
    submitSteer,
    rows,
    discardQueued,
  });
  const {
    steerFromComposer,
    queueFromComposer,
    interruptAndSend,
    interruptSteer,
    submitDuringRun,
  } = useDuringRunActions({
    composerDisabledRef,
    filesLoading,
    canSteer,
    canControlGeneration,
    hasRealConvoId,
    duringRunActive,
    pausedOnApproval,
    effectiveAction,
    pendingReasoningOverride,
    enqueue,
    composer,
    takeComposerDraft,
    submitSteer,
    armDrainAfterAbort,
    stopGenerating,
  });

  /** Memoized so consumers like `memo(Bar)` and `memo(Queue)` can bail on the
   * `steering` prop; a fresh literal here would defeat them every render. */
  return useMemo(
    () => ({
      enabled,
      queueKey,
      canSteer,
      canControlGeneration,
      duringRunActive,
      canSendQueuedNow,
      effectiveAction,
      defaultAction,
      pendingReasoningOverride,
      pausedOnApproval,
      setDefaultAction,
      submitDuringRun,
      steerFromComposer,
      queueFromComposer,
      submitSteer,
      retrySteer,
      removeSteer,
      convertSteerToQueue,
      queueReclaimedSteer,
      enqueue,
      removeQueued,
      holdQueued,
      toggleQueuedHold,
      discardQueued,
      dismissRecovery,
      rewakeDrain,
      reorderQueued,
      restoreQueuedOrder,
      sendQueuedNow,
      interruptAndSend,
      interruptSteer,
    }),
    [
      enabled,
      queueKey,
      canSteer,
      canControlGeneration,
      duringRunActive,
      canSendQueuedNow,
      effectiveAction,
      defaultAction,
      pendingReasoningOverride,
      pausedOnApproval,
      setDefaultAction,
      submitDuringRun,
      steerFromComposer,
      queueFromComposer,
      submitSteer,
      retrySteer,
      removeSteer,
      convertSteerToQueue,
      queueReclaimedSteer,
      enqueue,
      removeQueued,
      holdQueued,
      toggleQueuedHold,
      discardQueued,
      dismissRecovery,
      rewakeDrain,
      reorderQueued,
      restoreQueuedOrder,
      sendQueuedNow,
      interruptAndSend,
      interruptSteer,
    ],
  );
}

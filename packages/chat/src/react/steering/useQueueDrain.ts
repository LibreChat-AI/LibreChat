import { useRef, useEffect, useMemo, useCallback } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { Constants, DEFAULT_QUEUED_SEND_LOCK_TIMEOUT_MS } from 'librechat-data-provider';
import type {
  QueueSendLock,
  QueuedTurnAsk,
  QueuedMessage,
  QueuedMessageOrigin,
  RunEnd,
} from '../../core';
import {
  mergeQueuedMessages,
  recoveryDisposition,
  canRestoreRecovery,
  acquireQueueSendLock,
  releaseQueueSendLock,
  hasQueuedIntent,
  parkRunEnd,
  batchFileIds,
  pickDrainable,
  isBoundaryAdmitted,
  insertQueuedOrigin,
  matchesInterruptArm,
  collectQueuedFileIds,
  selectQueuedTurnReveal,
  consumeAdmittedBoundary,
  QUEUE_USAGE_RENEW_INTERVAL_MS,
} from '../../core';
import {
  settledQueuedTurnReceiptsByConvoId,
  pendingQueuedTurnEnqueueIdsByConvoId,
  pendingRunEndByConvoId,
  queuedMessagesByConvoId,
  drainAfterAbortByIndex,
  runEndByIndex,
} from '../steer/queue';
import { recoveryDispositionsFamily } from '../steer/recovery';
import { revealedQueuedTurnFamily } from '../steer/atoms';
import { useIsSubmitting } from '../submission';
import { useSteerHost } from '../steer/host';

/**
 * Auto-sends queued follow-up messages when a run finishes.
 *
 * Consumes the one-shot `runEndByIndex` signal written by the SSE handlers.
 * Rules:
 * - Drains only on a clean completion: a user Stop or an error leaves the
 *   queued chips for manual send, EXCEPT when the one-shot
 *   `drainAfterAbortByIndex` flag was armed by "interrupt & send".
 * - Waits for `isSubmitting` to be false so `ask()` isn't dropped by its
 *   in-flight guard (`useChatFunctions.ask` early-returns while submitting).
 * - Dequeues ONE message per run end: the new turn's own final event drains
 *   the next, so multi-message queues send FIFO in sequence.
 * - Migrates a queue keyed under `NEW_CONVO` to the real conversation id when
 *   the finished run started as a new-conversation submission.
 */
export default function useQueueDrain(
  index: string | number,
  activeConversationId: string | undefined,
  ask: QueuedTurnAsk,
  revealQueuedTurn?: (item: QueuedMessage, end: RunEnd) => void,
): void {
  const jotaiStore = useStore();
  const runEnd = useAtomValue(runEndByIndex(index));
  const parkedRunEnd = useAtomValue(
    pendingRunEndByConvoId(activeConversationId ?? Constants.NEW_CONVO),
  );
  const isSubmitting = useIsSubmitting(index);
  /** Keyed by pane, because the contended resource is this pane's submission
   * slot: the rail's "Send now" reaches the same `ask` through the composer. */
  const sendLockKey = String(index);
  const sendLockRef = useRef<QueueSendLock | null>(null);
  const revealLockRef = useRef(false);
  const host = useSteerHost();
  const markFilesUsage = host.useMarkFilesUsage();
  const { queuedSendLockTimeoutMs } = host.useSettings();
  const sendLockTimeoutMs = queuedSendLockTimeoutMs ?? DEFAULT_QUEUED_SEND_LOCK_TIMEOUT_MS;
  const ownQueue = useAtomValue(
    queuedMessagesByConvoId(activeConversationId ?? Constants.NEW_CONVO),
  );
  /** `drainNext` merges this in, and it outlives the URL update: items queued
   *  during the first turn stay keyed here until that run ends. Renewing only
   *  the active id would skip them for the whole of that run. */
  const newConvoQueue = useAtomValue(queuedMessagesByConvoId(Constants.NEW_CONVO));
  /** Receipt settlement can consume the parked terminal boundary without
   * changing whether another server-owned row remains. Subscribe here so the
   * drain effect observes that durable transition instead of reading it only
   * through a callback read whose other dependencies stayed unchanged. */
  const settledQueuedTurnReceipts = useAtomValue(
    settledQueuedTurnReceiptsByConvoId(activeConversationId ?? Constants.NEW_CONVO),
  );
  const hasServerOwnedQueue = [...ownQueue, ...newConvoQueue].some((item) => item.server != null);
  // A held head can leave the queue without changing the terminal signal.
  // Observe its identity so that dismissal wakes the parked boundary.
  const ownHeadId = ownQueue[0]?.id ?? null;
  const newConvoHeadId = newConvoQueue[0]?.id ?? null;
  /** The row the reveal would pick, and whether one is already revealed: a
   *  revealed head that is cancelled or dies before admission leaves the
   *  server-owned queue non-empty and its terminal evidence out of the
   *  settled receipts, so nothing above re-runs the effect for the row the
   *  backend moves on to. */
  const revealedQueuedTurn = useAtomValue(
    revealedQueuedTurnFamily(activeConversationId ?? Constants.NEW_CONVO),
  );
  const admissibleHeadId =
    [...ownQueue, ...newConvoQueue].find(
      (item) =>
        item.server?.id != null &&
        (item.server.status === 'queued' || item.server.status === 'claimed'),
    )?.id ?? null;

  /* Deduped because the two subscriptions are the same atom before migration.
   * Keyed by id list so the effect re-runs when the held set changes, not
   * whenever Recoil hands back a new array for the same contents. */
  const renewKey = [
    ...new Set([...collectQueuedFileIds(ownQueue), ...collectQueuedFileIds(newConvoQueue)]),
  ].join(',');
  const queuedFileIds = useMemo(() => (renewKey ? renewKey.split(',') : []), [renewKey]);

  /**
   * Heartbeat renewal while anything is queued.
   *
   * Renewing only at drain transitions ties an attachment's survival to
   * catching every state change, and a single run can stretch well past one
   * hold: it may interrupt for approval more than once, and each pause can
   * run to the configured window. Rather than hook every transition, renew on
   * a cadence far shorter than the hold itself, so no single gap can outlive
   * it. Bounded regardless: the server clamps each renewal against the file's
   * upload time. A queue nobody has open stops emitting these and lapses
   * normally.
   */
  useEffect(() => {
    if (queuedFileIds.length === 0) {
      return;
    }
    const renew = () => {
      for (const file_ids of batchFileIds(queuedFileIds)) {
        markFilesUsage({ file_ids });
      }
    };
    /* Immediately, not one interval later: returning to a conversation whose
     * hold is nearly up would otherwise wait out a full period first. */
    renew();
    const timer = setInterval(renew, QUEUE_USAGE_RENEW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [queuedFileIds, markFilesUsage]);

  /** Move a foreign pane signal to its conversation before the submission
   * gate. A different conversation can already be submitting on this pane;
   * waiting for it to become idle lets its own terminal signal replace the
   * first one. Matching interrupt intent travels with the exact terminal
   * epoch, while unrelated intent remains armed for its owner. */
  const parkForeignRunEnd = useCallback((): boolean => {
    const end = jotaiStore.get(runEndByIndex(index));
    if (end == null || end.conversationId == null || end.conversationId === activeConversationId) {
      return false;
    }
    const interruptArmed = matchesInterruptArm(jotaiStore.get(drainAfterAbortByIndex(index)), end);
    if (interruptArmed) {
      jotaiStore.set(drainAfterAbortByIndex(index), false);
    }
    jotaiStore.set(pendingRunEndByConvoId(end.conversationId), parkRunEnd(end, interruptArmed));
    jotaiStore.set(runEndByIndex(index), null);
    return true;
  }, [index, activeConversationId, jotaiStore]);

  // Fully synchronous: every read and write below happens in one task, so no
  // other writer can interleave between deciding and consuming the signal.
  const drainNext = useCallback(():
    | {
        kind: 'drain';
        next: QueuedMessage;
        conversationId: string;
        queuedMessageOrigin: QueuedMessageOrigin;
        expectedPredecessorCreatedAt?: number;
      }
    | { kind: 'reveal'; item: QueuedMessage; end: RunEnd }
    | null => {
    /**
     * `ask` is the MOUNTED view's sender: draining another conversation's
     * follow-up here would submit it into the wrong chat. Park the signal
     * under ITS conversation (freeing the shared index slot so a later run
     * cannot overwrite it) and drain when the user returns. The armed
     * interrupt flag travels WITH the parked signal: leaving it on the index
     * would let another run on this pane consume it (or drain the wrong
     * conversation).
     */
    if (parkForeignRunEnd()) {
      return null;
    }
    let end = jotaiStore.get(runEndByIndex(index));
    let fromParked = false;
    if (end == null && activeConversationId) {
      const parked = jotaiStore.get(pendingRunEndByConvoId(activeConversationId));
      if (parked != null) {
        end = parked;
        fromParked = true;
      }
    }
    if (end == null) {
      return null;
    }
    const indexArmed = jotaiStore.get(drainAfterAbortByIndex(index));
    const matchingIndexArm = matchesInterruptArm(indexArmed, end);
    const interruptArmed = matchingIndexArm || end.interruptArmed === true;

    const conversationId = end.conversationId;
    if (!conversationId) {
      return null;
    }

    const shouldMigrate = end.startedAsNewConvo === true && conversationId !== Constants.NEW_CONVO;
    const newConvoQueue = shouldMigrate
      ? jotaiStore.get(queuedMessagesByConvoId(Constants.NEW_CONVO))
      : [];
    const ownQueue = jotaiStore.get(queuedMessagesByConvoId(conversationId));
    /** Both queues are ordered independently, but migration crosses the
     * key boundary: an interrupt queued under the resolved conversation
     * must still outrank an ordinary follow-up captured under NEW_CONVO. */
    const merged = shouldMigrate ? mergeQueuedMessages(newConvoQueue, ownQueue) : ownQueue;

    const shouldDrain = end.outcome === 'completed' || interruptArmed;
    const settledReceipts = jotaiStore.get(settledQueuedTurnReceiptsByConvoId(conversationId));
    const pendingEnqueueIds = jotaiStore.get(pendingQueuedTurnEnqueueIdsByConvoId(conversationId));
    const consumedByServerAdmission = isBoundaryAdmitted(settledReceipts, end.generationCreatedAt);
    const consumeEnd = () => {
      if (fromParked && activeConversationId) {
        jotaiStore.set(pendingRunEndByConvoId(activeConversationId), null);
      } else {
        jotaiStore.set(runEndByIndex(index), null);
      }
      if (matchingIndexArm) {
        jotaiStore.set(drainAfterAbortByIndex(index), false);
      }
    };
    if (consumedByServerAdmission) {
      /** Admission consumed this terminal boundary on the server. A late
       * client terminal observation cannot authorize a second successor. */
      if (shouldMigrate && newConvoQueue.length > 0) {
        jotaiStore.set(queuedMessagesByConvoId(Constants.NEW_CONVO), []);
        jotaiStore.set(queuedMessagesByConvoId(conversationId), merged);
      }
      jotaiStore.set(settledQueuedTurnReceiptsByConvoId(conversationId), (previous) =>
        consumeAdmittedBoundary(previous, end.generationCreatedAt, pendingEnqueueIds),
      );
      consumeEnd();
      return null;
    }
    /** A server-owned Agent row means the backend owns the next fresh-turn
     * admission. Do not let a legacy/recovered local row race or overtake
     * it. Keep this terminal boundary available until the authoritative
     * queue snapshot proves whether a server-started successor now owns it. */
    const serverOwnsBoundary = merged.some((item) => item.server != null);
    if (serverOwnsBoundary) {
      /** Keep the one-shot terminal signal until the authoritative snapshot
       * removes the server row. If it was admitted, its own later terminal
       * signal orders the remaining local queue; if it was cancelled/dead,
       * this signal still lets the legacy successor make progress. The
       * head the server is about to admit can already be shown as the
       * next user turn; the signal itself stays untouched. */
      const reveal = selectQueuedTurnReveal(end, merged);
      return reveal == null ? null : { kind: 'reveal', item: reveal, end };
    }

    const head = merged[0];
    if (
      shouldDrain &&
      head != null &&
      recoveryDisposition(jotaiStore.get(recoveryDispositionsFamily(conversationId)), head) != null
    ) {
      // The first row still owns this boundary. Keep it until dismissal, even when
      // a later local row is immediately sendable; a user must choose its fate.
      if (shouldMigrate && newConvoQueue.length > 0) {
        jotaiStore.set(queuedMessagesByConvoId(Constants.NEW_CONVO), []);
        jotaiStore.set(queuedMessagesByConvoId(conversationId), merged);
      }
      return null;
    }
    // Intent-held and explicitly refused rows are skipped by the redesigned rail.
    consumeEnd();

    /** A row the rail is mid-edit or mid-remove on is spoken for: its words
     * are already on their way to the composer, and sending them from here
     * would deliver the message the user is in the middle of taking back.
     * A row swept in from a REJECTED steer is spoken for too: it carries
     * words the server refused, and its failure surface offers Retry and
     * "Send as new" precisely so the user chooses.
     * Both are skipped rather than blocking the whole queue, so an
     * untouched follow-up behind them still goes on this run end. */
    const { next, remainder, origin } = shouldDrain
      ? pickDrainable(
          merged,
          (item) =>
            hasQueuedIntent(item.id) ||
            item.needsExplicitSend === true ||
            recoveryDisposition(jotaiStore.get(recoveryDispositionsFamily(conversationId)), item) !=
              null,
        )
      : { next: null, remainder: merged, origin: undefined };

    if (shouldMigrate && newConvoQueue.length > 0) {
      jotaiStore.set(queuedMessagesByConvoId(Constants.NEW_CONVO), []);
    }
    if (remainder.length !== ownQueue.length || shouldMigrate || next != null) {
      jotaiStore.set(queuedMessagesByConvoId(conversationId), remainder);
    }
    return next != null && origin != null
      ? {
          kind: 'drain',
          next,
          conversationId,
          queuedMessageOrigin: origin,
          expectedPredecessorCreatedAt:
            end.generationCreatedAt ?? next.expectedPredecessorCreatedAt,
        }
      : null;
  }, [index, activeConversationId, jotaiStore, parkForeignRunEnd]);

  const restoreQueued = useCallback(
    (convoId: string, origin: QueuedMessageOrigin) => {
      if (!canRestoreRecovery(jotaiStore.get(recoveryDispositionsFamily(convoId)), origin.item))
        return;
      jotaiStore.set(queuedMessagesByConvoId(convoId), (prev) => insertQueuedOrigin(prev, origin));
    },
    [jotaiStore],
  );

  /** Held only until the pane's submission state moves or it changes chat: past
   * either, both callers gate on `isSubmitting` directly and the claim is spent.
   *
   * Released from a cleanup rather than an effect body, because React runs every
   * cleanup in a commit before any effect body: a stale claim can never starve
   * the acquire below, and this release can never free a slot the composer's own
   * submission in the same commit.
   */
  useEffect(
    () => () => {
      releaseQueueSendLock(sendLockRef.current);
      sendLockRef.current = null;
      revealLockRef.current = false;
    },
    [isSubmitting, sendLockKey, activeConversationId],
  );

  useEffect(() => {
    if (
      runEnd != null &&
      runEnd.conversationId != null &&
      runEnd.conversationId !== activeConversationId
    ) {
      parkForeignRunEnd();
      return;
    }
    if (revealLockRef.current && revealedQueuedTurn == null) {
      releaseQueueSendLock(sendLockRef.current);
      sendLockRef.current = null;
      revealLockRef.current = false;
    }
    if ((runEnd == null && parkedRunEnd == null) || isSubmitting) {
      return;
    }
    /** `isSubmitting` above is a render-old read: the rail's own "Send now"
     * can already have called `ask` for this pane in the current browser task.
     * Claimed BEFORE the signal is consumed so a refusal leaves the run end
     * armed for the next commit instead of dropping the queue on the floor. */
    const lock = acquireQueueSendLock(sendLockKey, sendLockTimeoutMs);
    if (lock == null) {
      return;
    }
    const drained = drainNext();
    if (drained == null) {
      releaseQueueSendLock(lock);
      return;
    }
    sendLockRef.current = lock;
    revealLockRef.current = drained.kind === 'reveal';
    if (drained.kind === 'reveal') {
      if (revealQueuedTurn == null) {
        releaseQueueSendLock(lock);
        sendLockRef.current = null;
        revealLockRef.current = false;
        return;
      }
      revealQueuedTurn(drained.item, drained.end);
      return;
    }
    const { next, conversationId, queuedMessageOrigin, expectedPredecessorCreatedAt } = drained;
    // The queued item is the FULL submission context: explicit (possibly
    // empty) overrides stop `ask` from vacuuming up files, quotes, or skill
    // picks the user has staged in the composer for their NEXT message.
    const accepted = ask(
      {
        text: next.text,
        // Recovery can fail after the user-row save but before the parked
        // source commit. Every attempt upserts the same source-derived row
        // while its generation idempotency key rotates independently.
        ...(next.recoverySteerId != null && {
          overrideUserMessageId: next.recoverySteerId,
        }),
      },
      {
        overrideFiles: next.files ?? [],
        overrideQuotes: next.quotes ?? [],
        overrideManualSkills: next.manualSkills ?? [],
        overrideReasoning: next.reasoningOverride ?? null,
        overrideClientRequestId: next.clientRequestId,
        overrideRecoverySteerId: next.recoverySteerId,
        overrideExpectedPredecessorCreatedAt: expectedPredecessorCreatedAt,
        overrideQueuedMessageOrigin: queuedMessageOrigin,
      },
    );
    if (accepted === false) {
      releaseQueueSendLock(lock);
      if (sendLockRef.current === lock) {
        sendLockRef.current = null;
      }
      // `ask` refused without sending (e.g. the conversation history is not
      // in the query cache yet, right after navigating back). Restore the
      // item so the user's text is never silently dropped, the chip stays
      // available for manual send.
      restoreQueued(conversationId, queuedMessageOrigin);
      /** Popping and restoring leaves the held set identical, so the renewal
       *  effect sees no change and will not re-run. Draining normally does
       *  change the set, and renews itself. Fire-and-forget: send-time
       *  marking is the backstop. */
      for (const file_ids of batchFileIds(collectQueuedFileIds([next]))) {
        markFilesUsage({ file_ids });
      }
    }
  }, [
    runEnd,
    parkedRunEnd,
    ownHeadId,
    newConvoHeadId,
    isSubmitting,
    sendLockKey,
    sendLockTimeoutMs,
    activeConversationId,
    parkForeignRunEnd,
    drainNext,
    restoreQueued,
    markFilesUsage,
    hasServerOwnedQueue,
    settledQueuedTurnReceipts,
    revealedQueuedTurn,
    admissibleHeadId,
    revealQueuedTurn,
    ask,
  ]);
}

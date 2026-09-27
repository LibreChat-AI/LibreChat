import { useEffect, useMemo } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { Constants } from 'librechat-data-provider';
import { useRecoilValue, useRecoilCallback } from 'recoil';
import type { DrainAfterAbort, QueuedMessage, QueuedMessageOrigin, RunEnd } from '~/store/families';
import type { TAskFunction } from '~/common';
import {
  recoveryDispositionsFamily,
  recoveryDisposition,
  canRestoreRecovery,
} from '~/components/Chat/Steering/recovery';
import { selectQueuedTurnReveal } from '~/hooks/Chat/useQueuedTurnReveal';
import { useMarkFilesUsageMutation } from '~/data-provider';
import { revealedQueuedTurnFamily } from '~/store/steer';
import store from '~/store';

/** Mirrors the server's per-request cap on a usage touch. */
const QUEUE_USAGE_MAX_FILES = 10;

/** Well under the server's smallest hold (24h), so no gap between renewals
 *  can outlive one, however long a run pauses. */
const QUEUE_USAGE_RENEW_INTERVAL_MS = 30 * 60 * 1000;

const collectQueuedFileIds = (items: QueuedMessage[]): string[] => {
  const fileIds: string[] = [];
  for (const item of items) {
    if (item.server != null) {
      continue;
    }
    for (const file of item.files ?? []) {
      if (typeof file.file_id === 'string' && file.file_id.length > 0) {
        fileIds.push(file.file_id);
      }
    }
  }
  return fileIds;
};

/** The server caps ids per request, so a queue holding more than one batch
 *  has to renew in several. Truncating instead would leave everything after
 *  the first batch on its enqueue-time hold. */
const batchFileIds = (fileIds: string[]): string[][] => {
  const batches: string[][] = [];
  for (let i = 0; i < fileIds.length; i += QUEUE_USAGE_MAX_FILES) {
    batches.push(fileIds.slice(i, i + QUEUE_USAGE_MAX_FILES));
  }
  return batches;
};

const compareQueuedMessages = (a: QueuedMessage, b: QueuedMessage): number =>
  Number(b.priority ?? false) - Number(a.priority ?? false) || a.createdAt - b.createdAt;

/** Interrupt intent belongs to one generation, never to whichever terminal
 * event happens to occupy the shared pane slot next. The NEW_CONVO alias is
 * the one exception: after its first successful start, the terminal event
 * carries the resolved conversation id while migrating the NEW_CONVO queue. */
const matchesInterruptArm = (armed: DrainAfterAbort | false, end: RunEnd): boolean => {
  if (armed === false || end.generationCreatedAt == null) {
    return false;
  }
  const sameConversation =
    armed.conversationId === end.conversationId ||
    (end.startedAsNewConvo === true && armed.conversationId === String(Constants.NEW_CONVO));
  return sameConversation && armed.generationCreatedAt === end.generationCreatedAt;
};

/**
 * Auto-sends queued follow-up messages when a run finishes.
 *
 * Consumes the one-shot `runEndByIndex` signal written by the SSE handlers.
 * Rules:
 * - Drains only on a clean completion — a user Stop or an error leaves the
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
  ask: TAskFunction,
  revealQueuedTurn?: (item: QueuedMessage, end: RunEnd) => void,
) {
  const jotaiStore = useStore();
  const runEnd = useRecoilValue(store.runEndByIndex(index));
  const parkedRunEnd = useRecoilValue(
    store.pendingRunEndByConvoId(activeConversationId ?? Constants.NEW_CONVO),
  );
  const isSubmitting = useRecoilValue(store.isSubmittingFamily(index));
  const { mutate: markFilesUsage } = useMarkFilesUsageMutation();
  const ownQueue = useRecoilValue(
    store.queuedMessagesByConvoId(activeConversationId ?? Constants.NEW_CONVO),
  );
  /** `drainNext` merges this in, and it outlives the URL update: items queued
   *  during the first turn stay keyed here until that run ends. Renewing only
   *  the active id would skip them for the whole of that run. */
  const newConvoQueue = useRecoilValue(store.queuedMessagesByConvoId(Constants.NEW_CONVO));
  /** Receipt settlement can consume the parked terminal boundary without
   * changing whether another server-owned row remains. Subscribe here so the
   * drain effect observes that durable transition instead of reading it only
   * through a callback snapshot whose other dependencies stayed unchanged. */
  const settledQueuedTurnReceipts = useRecoilValue(
    store.settledQueuedTurnReceiptsByConvoId(activeConversationId ?? Constants.NEW_CONVO),
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
  const parkForeignRunEnd = useRecoilCallback(
    ({ snapshot, set }) =>
      (): boolean => {
        const end = snapshot.getLoadable(store.runEndByIndex(index)).getValue();
        if (
          end == null ||
          end.conversationId == null ||
          end.conversationId === activeConversationId
        ) {
          return false;
        }
        const armed = snapshot.getLoadable(store.drainAfterAbortByIndex(index)).getValue();
        const interruptArmed = matchesInterruptArm(armed, end);
        if (interruptArmed) {
          set(store.drainAfterAbortByIndex(index), false);
        }
        set(store.pendingRunEndByConvoId(end.conversationId), {
          ...end,
          ...((end.interruptArmed === true || interruptArmed) && {
            interruptArmed: true,
          }),
        });
        set(store.runEndByIndex(index), null);
        return true;
      },
    [index, activeConversationId],
  );

  // Fully synchronous reads (getLoadable): a useRecoilCallback snapshot is
  // only guaranteed valid for the callback's synchronous execution, so no
  // awaits may interleave with the reads.
  const drainNext = useRecoilCallback(
    ({ snapshot, set }) =>
      ():
        | {
            kind: 'drain';
            next: QueuedMessage;
            conversationId: string;
            queuedMessageOrigin: QueuedMessageOrigin;
            expectedPredecessorCreatedAt?: number;
          }
        | { kind: 'reveal'; item: QueuedMessage; end: RunEnd }
        | null => {
        let end = snapshot.getLoadable(store.runEndByIndex(index)).getValue();
        let fromParked = false;
        if (
          end != null &&
          end.conversationId != null &&
          end.conversationId !== activeConversationId
        ) {
          /**
           * `ask` is the MOUNTED view's sender — draining another
           * conversation's follow-up here would submit it into the wrong
           * chat. Park the signal under ITS conversation (freeing the shared
           * index slot so a later run cannot overwrite it) and drain when
           * the user returns. The armed interrupt flag travels WITH the
           * parked signal: leaving it on the index would let another run on
           * this pane consume it (or drain the wrong conversation).
           */
          const armedNow = snapshot.getLoadable(store.drainAfterAbortByIndex(index)).getValue();
          const interruptArmed = matchesInterruptArm(armedNow, end);
          if (interruptArmed) {
            set(store.drainAfterAbortByIndex(index), false);
          }
          set(store.pendingRunEndByConvoId(end.conversationId), {
            ...end,
            ...((end.interruptArmed === true || interruptArmed) && {
              interruptArmed: true,
            }),
          });
          set(store.runEndByIndex(index), null);
          return null;
        }
        if (end == null && activeConversationId) {
          const parked = snapshot
            .getLoadable(store.pendingRunEndByConvoId(activeConversationId))
            .getValue();
          if (parked != null) {
            end = parked;
            fromParked = true;
          }
        }
        if (end == null) {
          return null;
        }
        const indexArmed = snapshot.getLoadable(store.drainAfterAbortByIndex(index)).getValue();
        const matchingIndexArm = matchesInterruptArm(indexArmed, end);
        const interruptArmed = matchingIndexArm || end.interruptArmed === true;

        const conversationId = end.conversationId;
        if (!conversationId) {
          return null;
        }

        const shouldMigrate =
          end.startedAsNewConvo === true && conversationId !== Constants.NEW_CONVO;
        const newConvoQueue = shouldMigrate
          ? snapshot.getLoadable(store.queuedMessagesByConvoId(Constants.NEW_CONVO)).getValue()
          : [];
        const ownQueue = snapshot
          .getLoadable(store.queuedMessagesByConvoId(conversationId))
          .getValue();
        /** Both queues are ordered independently, but migration crosses the
         * key boundary: an interrupt queued under the resolved conversation
         * must still outrank an ordinary follow-up captured under NEW_CONVO. */
        const merged = shouldMigrate
          ? [...newConvoQueue, ...ownQueue].sort(compareQueuedMessages)
          : ownQueue;

        const shouldDrain = end.outcome === 'completed' || interruptArmed;
        const settledReceipts = snapshot
          .getLoadable(store.settledQueuedTurnReceiptsByConvoId(conversationId))
          .getValue();
        const pendingEnqueueIds = snapshot
          .getLoadable(store.pendingQueuedTurnEnqueueIdsByConvoId(conversationId))
          .getValue();
        const consumedReceiptIndex = settledReceipts.findIndex(
          (receipt) =>
            receipt.status === 'admitted' &&
            receipt.boundaryConsumed !== true &&
            end.generationCreatedAt != null &&
            receipt.effectivePredecessorCreatedAt === end.generationCreatedAt,
        );
        const consumedByServerAdmission = consumedReceiptIndex >= 0;
        const consumeEnd = () => {
          if (fromParked && activeConversationId) {
            set(store.pendingRunEndByConvoId(activeConversationId), null);
          } else {
            set(store.runEndByIndex(index), null);
          }
          if (matchingIndexArm) {
            set(store.drainAfterAbortByIndex(index), false);
          }
        };
        if (consumedByServerAdmission) {
          /** Admission consumed this terminal boundary on the server. A late
           * client terminal observation cannot authorize a second successor. */
          if (shouldMigrate && newConvoQueue.length > 0) {
            set(store.queuedMessagesByConvoId(Constants.NEW_CONVO), []);
            set(store.queuedMessagesByConvoId(conversationId), merged);
          }
          set(store.settledQueuedTurnReceiptsByConvoId(conversationId), (previous) => {
            let consumed = false;
            return previous.flatMap((receipt) => {
              if (
                !consumed &&
                receipt.status === 'admitted' &&
                receipt.boundaryConsumed !== true &&
                receipt.effectivePredecessorCreatedAt === end.generationCreatedAt
              ) {
                consumed = true;
                return pendingEnqueueIds.includes(receipt.clientRequestId)
                  ? [{ ...receipt, boundaryConsumed: true }]
                  : [];
              }
              return [receipt];
            });
          });
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
        const held =
          head != null &&
          recoveryDisposition(jotaiStore.get(recoveryDispositionsFamily(conversationId)), head) !=
            null;
        if (shouldDrain && held) {
          // The held source cannot spend this completion. Keep its one-shot
          // boundary so a successor can drain if the user dismisses the hold.
          if (shouldMigrate && newConvoQueue.length > 0) {
            set(store.queuedMessagesByConvoId(Constants.NEW_CONVO), []);
            set(store.queuedMessagesByConvoId(conversationId), merged);
          }
          return null;
        }

        // Consume only after server authority and held recoveries yield the
        // boundary. A later queue update cannot spend the same end twice.
        consumeEnd();

        const next = shouldDrain ? (head ?? null) : null;
        const remainder = next ? merged.slice(1) : merged;

        if (shouldMigrate && newConvoQueue.length > 0) {
          set(store.queuedMessagesByConvoId(Constants.NEW_CONVO), []);
        }
        if (remainder.length !== ownQueue.length || shouldMigrate || next != null) {
          set(store.queuedMessagesByConvoId(conversationId), remainder);
        }
        return next
          ? {
              kind: 'drain',
              next,
              conversationId,
              queuedMessageOrigin: {
                item: next,
                beforeIds: [],
                afterIds: remainder.map((item) => item.id),
              },
              expectedPredecessorCreatedAt:
                end.generationCreatedAt ?? next.expectedPredecessorCreatedAt,
            }
          : null;
      },
    [index, activeConversationId, jotaiStore],
  );

  const restoreQueued = useRecoilCallback(
    ({ set }) =>
      (convoId: string, item: QueuedMessage) => {
        set(store.queuedMessagesByConvoId(convoId), (prev) =>
          !canRestoreRecovery(jotaiStore.get(recoveryDispositionsFamily(convoId)), item) ||
          prev.some((queued) => queued.id === item.id)
            ? prev
            : [item, ...prev],
        );
      },
    [jotaiStore],
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
    if ((runEnd == null && parkedRunEnd == null) || isSubmitting) {
      return;
    }
    const drained = drainNext();
    if (drained == null) {
      return;
    }
    if (drained.kind === 'reveal') {
      revealQueuedTurn?.(drained.item, drained.end);
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
        overrideClientRequestId: next.clientRequestId,
        overrideRecoverySteerId: next.recoverySteerId,
        overrideExpectedPredecessorCreatedAt: expectedPredecessorCreatedAt,
        overrideQueuedMessageOrigin: queuedMessageOrigin,
      },
    );
    if (accepted === false) {
      // `ask` refused without sending (e.g. the conversation history is not
      // in the query cache yet, right after navigating back). Restore the
      // item so the user's text is never silently dropped, the chip stays
      // available for manual send.
      restoreQueued(conversationId, next);
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

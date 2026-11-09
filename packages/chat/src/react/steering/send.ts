import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from 'jotai';
import type { TMessage } from 'librechat-data-provider';
import type { QueueSendLock, QueuedMessage, QueuedMessageContext } from '../../core';
import type { QueuedRecovery } from './recovery';
import type { SubmitSteer } from './submit';
import type { QueueRows } from './rows';
import {
  hasQueuedIntent,
  recoveryDisposition,
  acquireQueueSendLock,
  releaseQueueSendLock,
} from '../../core';
import { recoveryDispositionsFamily } from '../steer/recovery';

export interface QueuedSend {
  sendQueuedNow: (item: QueuedMessage, opts?: { preempt?: boolean }) => void;
}

/** Sends one queued row now: into the live run as a steer when it can take
 *  one, otherwise as a new turn once the pane's submission slot is free. */
export default function useQueuedSend({
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
}: {
  index: number;
  queueKey: string;
  isSubmitting: boolean;
  duringRunActive: boolean;
  canSteer: boolean;
  sendLockTimeoutMs: number;
  sendNow: (
    text: string,
    files?: TMessage['files'],
    context?: QueuedMessageContext,
  ) => false | void;
  submitSteer: SubmitSteer;
  rows: Pick<QueueRows, 'takeQueued' | 'restoreQueued' | 'releaseQueuedOrigin'>;
  discardQueued: QueuedRecovery['discardQueued'];
}): QueuedSend {
  const jotaiStore = useStore();
  const { takeQueued, restoreQueued, releaseQueuedOrigin } = rows;
  /** `ask()` does not flip `isSubmitting` until the submission effect renders.
   * Two queued-row clicks in the same browser task would otherwise both remove
   * their items and the second submission could overwrite the first; and the
   * run-end drain, which submits into the SAME pane slot, cannot see a ref that
   * lives in this hook. The claim is shared with `useQueueDrain` and keyed by
   * pane, because the contended resource is `isSubmittingFamily(index)`. */
  const sendLockKey = String(index);
  const idleSendLockRef = useRef<QueueSendLock | null>(null);

  /** Held only until the pane's submission state moves or it changes chat: past
   * either, both callers gate on `isSubmitting` directly and the claim is spent.
   *
   * Released from a cleanup rather than an effect body, because React runs every
   * cleanup in a commit before any effect body: this can never free a slot the
   * drain's effect claimed in the same commit. */
  useEffect(
    () => () => {
      releaseQueueSendLock(idleSendLockRef.current);
      idleSendLockRef.current = null;
    },
    [isSubmitting, sendLockKey, queueKey],
  );

  /** Chip action: send a queued message into the live run instead. Keys on
   *  steer availability, not the default action: a queue-preferring user
   *  clicking send-now explicitly asked to inject into the live run. The
   *  item's attachments ride the steer; its quotes/skills travel as the
   *  restore context so a degraded steer requeues/sends with them intact.
   *  `preempt` escalates the steer to interrupt at the next safe token
   *  boundary; it only means something on the live-run path. */
  const sendLocalQueuedNow = useCallback(
    (item: QueuedMessage, opts?: { preempt?: boolean }) => {
      if (
        hasQueuedIntent(item.id) ||
        recoveryDisposition(jotaiStore.get(recoveryDispositionsFamily(queueKey)), item) != null
      ) {
        return;
      }
      /** In answer mode (and any other submission-owned non-steerable state)
       * there is no immediate path. Refuse before touching queue state so a
       * stale/direct caller cannot perform the old remove-and-restore no-op. */
      if (isSubmitting && (!duringRunActive || !canSteer || item.recoverySteerId != null)) {
        return;
      }
      /** Keep request-scoped reasoning on a new generation; injecting this
       * item into the active run would silently ignore the selection. */
      if (duringRunActive && item.reasoningOverride != null) {
        return;
      }
      /* No fallback to the captured item: the only way it is missing is that
         something else already took it, likely the run-end drain moments before
         this click landed. Re-sending it would send the same words twice. */
      const origin = takeQueued(item.id);
      if (origin == null) {
        return;
      }
      const taken = origin.item;
      if (duringRunActive && canSteer) {
        const consumed = submitSteer(
          taken.text,
          taken.files,
          { quotes: taken.quotes, manualSkills: taken.manualSkills },
          {
            ...(opts?.preempt === true && { preempt: true }),
            queuedOrigin: origin,
          },
        );
        if (!consumed) {
          restoreQueued(origin);
        }
        return;
      }
      if (!isSubmitting) {
        const lock = acquireQueueSendLock(sendLockKey, sendLockTimeoutMs);
        if (lock == null) {
          restoreQueued(origin);
          return;
        }
        idleSendLockRef.current = lock;
        const releaseLock = () => {
          releaseQueueSendLock(lock);
          if (idleSendLockRef.current === lock) {
            idleSendLockRef.current = null;
          }
        };
        // Explicit (possibly empty) overrides: the queued item is the full
        // submission context, never the composer's staged files/quotes/picks.
        let accepted: false | void;
        try {
          accepted = sendNow(taken.text, taken.files ?? [], {
            quotes: taken.quotes,
            manualSkills: taken.manualSkills,
            reasoningOverride: taken.reasoningOverride,
            clientRequestId: taken.clientRequestId,
            recoverySteerId: taken.recoverySteerId,
            expectedPredecessorCreatedAt: taken.expectedPredecessorCreatedAt,
            queuedMessageOrigin: origin,
          });
        } catch (error) {
          releaseLock();
          restoreQueued(origin);
          throw error;
        }
        if (accepted === false) {
          releaseLock();
          // `ask` refused without sending: restore the chip so the user's
          // text is never silently dropped (mirrors useQueueDrain).
          restoreQueued(origin);
        } else {
          releaseQueuedOrigin(origin);
        }
        return;
      }
      /** The run still owns the send slot but cannot accept a steer (approval
       *  pause/answer transition): put the untouched item back where it was. */
      restoreQueued(origin);
    },
    [
      takeQueued,
      jotaiStore,
      queueKey,
      duringRunActive,
      canSteer,
      submitSteer,
      isSubmitting,
      sendNow,
      sendLockKey,
      sendLockTimeoutMs,
      restoreQueued,
      releaseQueuedOrigin,
    ],
  );

  const queuedActionClaimsRef = useRef(new Set<string>());
  const sendQueuedNow = useCallback(
    (item: QueuedMessage, opts?: { preempt?: boolean }) => {
      /* A reasoning override belongs to the next provider request and cannot
         be injected into the one already running. Refuse before cancelling a
         durable server row, so it keeps its crash-safe ownership. */
      if (duringRunActive && item.reasoningOverride != null) {
        return;
      }
      if (item.server == null) {
        sendLocalQueuedNow(item, opts);
        return;
      }
      if (queuedActionClaimsRef.current.has(item.id)) {
        return;
      }
      queuedActionClaimsRef.current.add(item.id);
      void discardQueued(item)
        .then((discarded) => {
          if (discarded) {
            sendLocalQueuedNow(item, opts);
          }
        })
        .finally(() => {
          queuedActionClaimsRef.current.delete(item.id);
        });
    },
    [duringRunActive, discardQueued, sendLocalQueuedNow],
  );

  return useMemo(
    () => ({
      sendQueuedNow,
    }),
    [sendQueuedNow],
  );
}

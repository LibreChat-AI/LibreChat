import { useCallback, useEffect, useMemo } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { DEFAULT_QUEUED_TURN_RECONCILIATION_TIMEOUT_MS } from 'librechat-data-provider';
import type { TAgentQueuedTurnReceipt as AgentQueuedTurnReceipt } from 'librechat-data-provider';
import type { QueuedTurnReceiptSource } from '../../core';
import {
  queuedMessagesByConvoId,
  settledQueuedTurnReceiptsByConvoId,
  pendingQueuedTurnEnqueueIdsByConvoId,
} from '../steer/queue';
import { reconcileServerQueuedTurns, mergeSettledQueuedTurnEvidence } from '../../core';
import { useSteerHost } from '../steer/host';

export interface QueuedTurnReceipts {
  /** Folds server receipts into the settled evidence and, unless `direct`, the visible queue. */
  applyQueuedTurnReceipts: (
    receipts: AgentQueuedTurnReceipt[],
    source?: QueuedTurnReceiptSource,
  ) => void;
  /** Retires an enqueue callback; true when newer evidence already settled the request. */
  finishQueuedTurnEnqueue: (clientRequestId: string) => boolean;
}

/**
 * Keeps a conversation's queue in step with the server's queued-turn receipts:
 * polls while any row still expects one, reconciles each snapshot into the
 * visible rows, and expires transport-ambiguous rows whose reconciliation
 * window has elapsed.
 */
export default function useQueuedTurnReceipts({
  conversationId,
  queueKey,
  serverQueueEnabled,
}: {
  conversationId: string;
  queueKey: string;
  serverQueueEnabled: boolean;
}): QueuedTurnReceipts {
  const jotaiStore = useStore();
  const host = useSteerHost();
  const fileMap = host.useFileMap();
  const { queuedTurnReconciliationTimeoutMs } = host.useSettings();
  const queuedMessages = useAtomValue(queuedMessagesByConvoId(queueKey));
  const setQueuedMessages = useSetAtom(queuedMessagesByConvoId(queueKey));
  /** Bound transport-outcome reconciliation while still guaranteeing several
   * list reads after the enqueue promise settles. Focus/remount remains a later
   * reconciliation path; a slow proxy or a delayed read replica needs the
   * operator to widen this rather than wait for one. */
  const reconciliationWindowMs =
    queuedTurnReconciliationTimeoutMs ?? DEFAULT_QUEUED_TURN_RECONCILIATION_TIMEOUT_MS;
  const knownClientRequestIds = useMemo(
    () =>
      Array.from(
        new Set(
          queuedMessages.flatMap((item) =>
            item.server != null && item.clientRequestId != null ? [item.clientRequestId] : [],
          ),
        ),
      ).slice(0, 100),
    [queuedMessages],
  );
  const reconciliationUntil = queuedMessages.reduce<number | undefined>((latest, item) => {
    if (item.server?.status !== 'uncertain' || item.server.uncertainSince == null) {
      return latest;
    }
    const until = item.server.uncertainSince + reconciliationWindowMs;
    return latest == null ? until : Math.max(latest, until);
  }, undefined);
  const nextReconciliationExpiry = queuedMessages.reduce<number | undefined>((earliest, item) => {
    if (
      item.server?.status !== 'uncertain' ||
      item.server.uncertainSince == null ||
      item.server.reconciliationExpired === true
    ) {
      return earliest;
    }
    const expiry = item.server.uncertainSince + reconciliationWindowMs;
    return earliest == null ? expiry : Math.min(earliest, expiry);
  }, undefined);
  /** An expired uncertain row is held for manual recovery only; nothing the
   *  projection can say about it is still expected. */
  const expectsReceipts = useMemo(
    () =>
      queuedMessages.some(
        (item) =>
          item.server != null &&
          (item.server.status === 'sending' ||
            item.server.status === 'queued' ||
            item.server.status === 'claimed' ||
            (item.server.status === 'uncertain' && item.server.reconciliationExpired !== true)),
      ),
    [queuedMessages],
  );
  const serverQueuedTurns = host.useQueuedTurns(
    conversationId,
    serverQueueEnabled,
    knownClientRequestIds,
    reconciliationUntil,
    expectsReceipts,
  );

  const applyQueuedTurnReceipts = useCallback(
    (receipts: AgentQueuedTurnReceipt[], source: QueuedTurnReceiptSource = 'snapshot') => {
      const previousSettled = jotaiStore.get(settledQueuedTurnReceiptsByConvoId(queueKey));
      const previousPending = jotaiStore.get(pendingQueuedTurnEnqueueIdsByConvoId(queueKey));
      const completedRequestIds = new Set(
        source === 'enqueue' ? receipts.map((receipt) => receipt.clientRequestId) : [],
      );
      const nextPending = previousPending.filter((id) => !completedRequestIds.has(id));
      const settledByRequestId = new Map(
        previousSettled.map((receipt) => [receipt.clientRequestId, receipt]),
      );
      for (const receipt of receipts) {
        const existing = settledByRequestId.get(receipt.clientRequestId);
        const settled = mergeSettledQueuedTurnEvidence(existing, receipt, source);
        if (settled == null) {
          continue;
        }
        settledByRequestId.set(receipt.clientRequestId, settled);
      }
      const terminalForReconciliation = new Map(settledByRequestId);
      const pendingRequestIds = new Set(nextPending);
      const nextSettled = [...settledByRequestId.values()].filter(
        (receipt) =>
          (receipt.status === 'admitted' &&
            receipt.rootPredecessor !== true &&
            receipt.boundaryConsumed !== true) ||
          pendingRequestIds.has(receipt.clientRequestId),
      );
      if (source === 'enqueue') {
        jotaiStore.set(pendingQueuedTurnEnqueueIdsByConvoId(queueKey), nextPending);
      }
      if (
        nextSettled.length !== previousSettled.length ||
        nextSettled.some((receipt, index) => receipt !== previousSettled[index])
      ) {
        jotaiStore.set(settledQueuedTurnReceiptsByConvoId(queueKey), nextSettled);
      }
      if (source !== 'direct') {
        jotaiStore.set(queuedMessagesByConvoId(queueKey), (previous) =>
          reconcileServerQueuedTurns(
            previous,
            receipts,
            terminalForReconciliation,
            source === 'snapshot',
            fileMap,
          ),
        );
      }
    },
    [fileMap, queueKey, jotaiStore],
  );

  const finishQueuedTurnEnqueue = useCallback(
    (clientRequestId: string): boolean => {
      const settledReceipts = jotaiStore.get(settledQueuedTurnReceiptsByConvoId(queueKey));
      const settled = settledReceipts.find(
        (receipt) => receipt.clientRequestId === clientRequestId,
      );
      jotaiStore.set(pendingQueuedTurnEnqueueIdsByConvoId(queueKey), (previous) =>
        previous.filter((id) => id !== clientRequestId),
      );
      if (settled != null && (settled.status !== 'admitted' || settled.boundaryConsumed === true)) {
        jotaiStore.set(settledQueuedTurnReceiptsByConvoId(queueKey), (previous) =>
          previous.filter((receipt) => receipt.clientRequestId !== clientRequestId),
        );
      }
      return settled != null;
    },
    [queueKey, jotaiStore],
  );

  useEffect(() => {
    if (!serverQueueEnabled || serverQueuedTurns == null) {
      return;
    }
    applyQueuedTurnReceipts(serverQueuedTurns);
  }, [serverQueueEnabled, serverQueuedTurns, applyQueuedTurnReceipts]);
  useEffect(() => {
    if (!serverQueueEnabled || nextReconciliationExpiry == null) {
      return;
    }
    const expire = () => {
      const observedAt = Date.now();
      setQueuedMessages((previous) =>
        previous.map((item) => {
          if (
            item.server?.status !== 'uncertain' ||
            item.server.uncertainSince == null ||
            item.server.reconciliationExpired === true ||
            item.server.uncertainSince + reconciliationWindowMs > observedAt
          ) {
            return item;
          }
          return {
            ...item,
            server: { ...item.server, reconciliationExpired: true },
          };
        }),
      );
    };
    const delay = Math.max(0, nextReconciliationExpiry - Date.now());
    const timer = window.setTimeout(expire, delay);
    return () => window.clearTimeout(timer);
  }, [nextReconciliationExpiry, reconciliationWindowMs, serverQueueEnabled, setQueuedMessages]);

  return useMemo(
    () => ({ applyQueuedTurnReceipts, finishQueuedTurnEnqueue }),
    [applyQueuedTurnReceipts, finishQueuedTurnEnqueue],
  );
}

import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { useRecoilCallback, useRecoilValue } from 'recoil';
import type { PendingSteer } from '~/store/families';
import { pendingSteerCancelClientIdsFamily } from '~/store/steer';
import useSteerConvert from '~/hooks/Chat/useSteerConvert';
import { useCancelSteerMutation } from '~/data-provider';
import { appendAppliedSteerIds } from '~/utils';
import store from '~/store';

export type SteerCancelOutcome = 'reclaimed' | 'applied' | 'failed';

/**
 * Asks the server to drop a steer before its injection boundary. Only a
 * confirmed reclaim proves the words remain safe to move elsewhere.
 */
export function useSteerReclaim(conversationId: string) {
  const cancelMutation = useCancelSteerMutation();
  const activeGenerationCreatedAt = useRecoilValue(
    store.activeGenerationCreatedAtByConvoId(conversationId),
  );
  const setPendingCancelIds = useSetAtom(pendingSteerCancelClientIdsFamily(conversationId));
  const settleReclaimed = useRecoilCallback(
    ({ set }) =>
      (steer: PendingSteer) => {
        const ids = [steer.steerId, ...(steer.clientSteerId ? [steer.clientSteerId] : [])];
        const settled = new Set(ids);
        set(store.appliedSteerIdsByConvoId(conversationId), (prev) =>
          appendAppliedSteerIds(prev, ids),
        );
        set(store.pendingSteersByConvoId(conversationId), (prev) =>
          prev.filter(
            (item) =>
              !settled.has(item.steerId) &&
              (item.clientSteerId == null || !settled.has(item.clientSteerId)),
          ),
        );
        setPendingCancelIds((prev) => prev.filter((id) => !ids.includes(id)));
        set(store.queuedMessagesByConvoId(conversationId), (prev) =>
          prev.filter(
            (item) =>
              !settled.has(item.id) &&
              (item.recoverySteerId == null || !settled.has(item.recoverySteerId)) &&
              (item.recoveryClientSteerId == null || !settled.has(item.recoveryClientSteerId)),
          ),
        );
      },
    [conversationId, setPendingCancelIds],
  );

  return useCallback(
    async (steer: PendingSteer): Promise<SteerCancelOutcome> => {
      try {
        const generationCreatedAt =
          steer.generationCreatedAt ?? activeGenerationCreatedAt ?? undefined;
        if (generationCreatedAt == null) {
          return 'failed';
        }
        const { removed } = await cancelMutation.mutateAsync({
          conversationId,
          steerId: steer.steerId,
          ...(steer.clientSteerId && { clientSteerId: steer.clientSteerId }),
          generationCreatedAt,
        });
        if (removed === true) {
          settleReclaimed(steer);
          return 'reclaimed';
        }
        return 'applied';
      } catch {
        return 'failed';
      }
    },
    [conversationId, cancelMutation, settleReclaimed, activeGenerationCreatedAt],
  );
}

export function useSteerMoveToQueue(conversationId: string) {
  const reclaim = useSteerReclaim(conversationId);
  const convertSteersToQueued = useSteerConvert();

  return useCallback(
    async (steer: PendingSteer): Promise<SteerCancelOutcome> => {
      const outcome = await reclaim(steer);
      if (outcome === 'reclaimed') {
        convertSteersToQueued(conversationId, [steer], {
          generationProtocolVersion: steer.generationProtocolVersion,
          allowPreviouslyConvertedIds: [steer.steerId],
          bindRecoverySource: false,
        });
      }
      return outcome;
    },
    [conversationId, convertSteersToQueued, reclaim],
  );
}

export default function useSteerCancel(conversationId: string) {
  const reclaim = useSteerReclaim(conversationId);
  const setPendingCancelIds = useSetAtom(pendingSteerCancelClientIdsFamily(conversationId));
  const markOptimisticCancel = useRecoilCallback(
    ({ set }) =>
      (steer: PendingSteer) => {
        const clientId = steer.clientSteerId ?? steer.steerId;
        setPendingCancelIds((prev) => (prev.includes(clientId) ? prev : [...prev, clientId]));
        if (steer.status === 'sending') {
          set(store.pendingSteersByConvoId(conversationId), (prev) =>
            prev.filter((item) => item.steerId !== steer.steerId),
          );
        }
      },
    [conversationId, setPendingCancelIds],
  );
  const restoreReclaimedText = useRecoilCallback(
    ({ set }) =>
      (steer: PendingSteer) => {
        set(store.pendingComposerTextByConvoId(conversationId), (previous) =>
          previous == null || previous.length === 0 ? steer.text : `${previous}\n${steer.text}`,
        );
      },
    [conversationId],
  );
  const clearOptimisticCancel = useCallback(
    (steer: PendingSteer) => {
      const clientId = steer.clientSteerId ?? steer.steerId;
      setPendingCancelIds((prev) => prev.filter((id) => id !== clientId));
    },
    [setPendingCancelIds],
  );
  return useCallback(
    async (steer: PendingSteer): Promise<SteerCancelOutcome> => {
      if (steer.status === 'sending') {
        markOptimisticCancel(steer);
      }
      const outcome = await reclaim(steer);
      if (outcome === 'reclaimed') {
        restoreReclaimedText(steer);
        clearOptimisticCancel(steer);
      }
      return outcome;
    },
    [clearOptimisticCancel, markOptimisticCancel, reclaim, restoreReclaimedText],
  );
}

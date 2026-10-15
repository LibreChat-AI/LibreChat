import { QueryKeys } from 'librechat-data-provider';
import { revealedQueuedTurnFamily } from '@librechat/chat/react';
import type { StreamStatusResponse, GenerationProtocolVersion } from '@librechat/chat';
import type { TMessage, TAgentQueuedTurnReceipt } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import type { useStore } from 'jotai';
import type { SteerState } from './steer';
import {
  isDetachedRunManual,
  detachedRunByConvoId,
  resolveDetachedRunEnd,
  pendingRunEndByConvoId,
} from '~/hooks/Chat/queue';
import { isQueuedTurnSuccessorOwed } from '~/data-provider';
import { dedupeSteersById } from '~/utils';

/**
 * Settles what a run that ended while this pane was away left behind: the reveal guard of a
 * queued turn that already landed, steers a terminal drain parked, stale local chips, and the
 * end of a run the pane left mid-stream, read from the history the server persisted.
 */
export function settleFinishedRun({
  jotaiStore,
  queryClient,
  steers,
  conversationId,
  streamStatus,
  streamStatusUpdatedAt,
  queuedTurnReceipts,
  getMessages,
  generationProtocolVersion,
}: {
  jotaiStore: ReturnType<typeof useStore>;
  queryClient: QueryClient;
  steers: Pick<SteerState, 'seedSteerChips' | 'settleAppliedSteerParts' | 'convertSteersToQueued'>;
  conversationId: string;
  streamStatus: StreamStatusResponse;
  streamStatusUpdatedAt: number;
  queuedTurnReceipts: TAgentQueuedTurnReceipt[] | undefined;
  getMessages: () => TMessage[] | undefined;
  generationProtocolVersion: GenerationProtocolVersion;
}): void {
  const revealFamily = revealedQueuedTurnFamily(conversationId);
  const pendingReveal = jotaiStore.get(revealFamily);
  /** A remounted pane may have missed attachment and the quiet-window
   * timer. An expired job has no epoch; require a fresh inactive read
   * after restored history before retiring its surviving handoff guard. */
  const historyUpdatedAt = queryClient.getQueryState([
    QueryKeys.messages,
    conversationId,
  ])?.dataUpdatedAt;
  if (
    pendingReveal != null &&
    streamStatus.active === false &&
    streamStatus.createdAt == null &&
    historyUpdatedAt != null &&
    streamStatusUpdatedAt >= historyUpdatedAt &&
    streamStatusUpdatedAt > Date.parse(pendingReveal.revealedAt) &&
    !isQueuedTurnSuccessorOwed(queuedTurnReceipts) &&
    (getMessages() ?? []).some(
      (message) => message.parentMessageId === pendingReveal.parentMessageId,
    )
  ) {
    jotaiStore.set(revealFamily, null);
  }

  // A terminal drain may have parked acknowledged steers no subscriber
  // received (tab closed / reload racing the final event); the status
  // claim returns them exactly once; restore as queued follow-up chips.
  // An expired pendingAction can report inactive BEFORE the sweeper parks
  // the steer queue: those steers still ride resumeState.pendingSteers,
  // so convert both lists (id-deduped) before the empty seed clears chips.
  const leftoverSteers = dedupeSteersById(
    streamStatus.unrecoveredSteers,
    streamStatus.resumeState?.pendingSteers,
  );
  if (conversationId && leftoverSteers.length > 0) {
    steers.convertSteersToQueued(conversationId, leftoverSteers, {
      generationProtocolVersion,
    });
  }
  // The run is terminal, so any remaining local pending chip is stale:
  // its steer either applied (inline part in the saved message) or rode
  // `unrecoveredSteers` above, the same empty-list reconcile as the resume path.
  steers.settleAppliedSteerParts(conversationId, getMessages());
  steers.seedSteerChips(conversationId, []);
  /** A run this pane stopped watching when the user left has ended on the server, which
   *  deleted the job. Its persisted response tells how it ended; parking that end lets the
   *  queue drain send a follow-up queued during the run, as an attached run would have.
   *  The cached history still holds the optimistic response the pane left, which lacks the
   *  persisted stop and error flags, so only a successful refetch of history may resolve it;
   *  when that fails or predates the saved response, the next visit tries again. */
  const detachedFamily = detachedRunByConvoId(conversationId);
  const detachedRun = jotaiStore.get(detachedFamily);
  const parkDetachedEnd = () => {
    if (detachedRun == null || jotaiStore.get(detachedFamily) !== detachedRun) {
      return;
    }
    if (isDetachedRunManual(jotaiStore.get, conversationId, detachedRun)) {
      jotaiStore.set(detachedFamily, null);
      return;
    }
    const end = resolveDetachedRunEnd(conversationId, detachedRun, getMessages());
    if (end == null) {
      return;
    }
    jotaiStore.set(detachedFamily, null);
    jotaiStore.set(pendingRunEndByConvoId(conversationId), end);
  };
  /** A run left for a manual send is retired without a read instead of refetching on every
   *  visit; the check repeats after the read, since a receipt can settle meanwhile. */
  if (detachedRun != null && isDetachedRunManual(jotaiStore.get, conversationId, detachedRun)) {
    jotaiStore.set(detachedFamily, null);
  } else if (detachedRun != null) {
    queryClient
      .refetchQueries(
        { queryKey: [QueryKeys.messages, conversationId], exact: true },
        { throwOnError: true },
      )
      .then(parkDetachedEnd, () => undefined);
  }
}

import { useMemo, useCallback } from 'react';
import { useStore, useSetAtom } from 'jotai';
import { liveAppliedSteerIdsAtom } from '@librechat/chat/react';
import type { TSubmission } from 'librechat-data-provider';
import type { ResumableSteers } from '@librechat/chat';
import type { QueuedMessageOrigin } from '~/hooks/Chat/queue';
import type { SteerState } from './steer';
import {
  blockRecovery,
  canRestoreRecovery,
  recoveryDispositionsFamily,
} from '~/components/Chat/Steering/recovery';
import { appendAppliedSteerIds, collectAppliedSteerIds, insertQueuedOrigin } from '~/utils';
import { queuedMessagesByConvoId } from '~/hooks/Chat/queue';

/**
 * The pane's steer chips as a resumable run drives them: the chip state itself comes from
 * `useSteerState`, and this adds the recovery and queue bookkeeping the run reaches through.
 */
export default function useResumableSteers(steerState: SteerState): ResumableSteers {
  const jotaiStore = useStore();
  const setLiveAppliedSteerIds = useSetAtom(liveAppliedSteerIdsAtom);
  const {
    resolveSteerChip,
    updateSteerChips,
    seedSteerChips,
    settleAppliedSteerParts,
    convertSteersToQueued,
    convertLocalSteersToQueued,
  } = steerState;

  const restoreQueuedSubmission = useCallback(
    (failedSubmission: TSubmission, expectedPredecessorCreatedAt?: number) => {
      const conversationId = failedSubmission.conversation?.conversationId;
      const origin = failedSubmission.queuedMessageOrigin as QueuedMessageOrigin | undefined;
      if (!conversationId || origin == null) {
        return;
      }
      jotaiStore.set(queuedMessagesByConvoId(conversationId), (prev) =>
        canRestoreRecovery(jotaiStore.get(recoveryDispositionsFamily(conversationId)), origin.item)
          ? insertQueuedOrigin(prev, origin, expectedPredecessorCreatedAt)
          : prev,
      );
    },
    [jotaiStore],
  );

  return useMemo<ResumableSteers>(
    () => ({
      resolve: resolveSteerChip,
      isRecoveryHeld: (conversationId, recoverySteerId) =>
        jotaiStore.get(recoveryDispositionsFamily(conversationId))[recoverySteerId] != null,
      blockRecovery: (conversationId, recoverySteerId) =>
        jotaiStore.set(recoveryDispositionsFamily(conversationId), (previous) =>
          blockRecovery(previous, recoverySteerId),
        ),
      restoreQueued: restoreQueuedSubmission,
      update: updateSteerChips,
      markLiveApplied: (steerId) =>
        setLiveAppliedSteerIds((prev) => appendAppliedSteerIds(prev, [steerId])),
      seed: seedSteerChips,
      appliedIds: collectAppliedSteerIds,
      settleApplied: settleAppliedSteerParts,
      convertToQueued: convertSteersToQueued,
      convertLocalToQueued: convertLocalSteersToQueued,
    }),
    [
      jotaiStore,
      resolveSteerChip,
      restoreQueuedSubmission,
      updateSteerChips,
      setLiveAppliedSteerIds,
      seedSteerChips,
      settleAppliedSteerParts,
      convertSteersToQueued,
      convertLocalSteersToQueued,
    ],
  );
}

import { useMemo, useCallback } from 'react';
import { v4 } from 'uuid';
import { useSetRecoilState } from 'recoil';
import { useStore, useSetAtom } from 'jotai';
import { Constants } from 'librechat-data-provider';
import { abortScrollFamily, showStopButtonByIndex, submissionByIndex } from '@librechat/chat/react';
import type { ResumableRun, ResumablePane, ResumableQueue } from '@librechat/chat';
import type { DrainAfterAbort, RunEnd } from '~/hooks/Chat/queue';
import type { EventHandlerParams } from './useEventHandlers';
import {
  isStoppedRun,
  runEndByIndex,
  isDetachedRunManual,
  detachedRunByConvoId,
  resolveDetachedRunEnd,
  drainAfterAbortByIndex,
  stopRequestedByConvoId,
} from '~/hooks/Chat/queue';
import { pendingApprovalActionFamily } from '~/components/Chat/approval/state';
import { clearComposerDrafts, resolveRunEndTarget } from '~/utils';
import store from '~/store';

/**
 * Reconciliation often crosses async query boundaries. By the time an old
 * generation settles, this pane may have armed "interrupt & send" for a new
 * conversation/generation. Recoil applies functional setters against the
 * latest value, so only consume the exact intent owned by this terminal path.
 */
const clearMatchingDrainAfterAbort = (
  armed: DrainAfterAbort | false,
  conversationId: string,
  generationCreatedAt: number,
): DrainAfterAbort | false =>
  armed !== false &&
  armed.conversationId === conversationId &&
  armed.generationCreatedAt === generationCreatedAt
    ? false
    : armed;

const replaceNewConversationUrl = (conversationId: string) => {
  if (window.location.pathname !== `/c/${Constants.NEW_CONVO}`) {
    return;
  }

  window.history.replaceState(
    window.history.state,
    '',
    `/c/${conversationId}${window.location.search}`,
  );
};

/**
 * The pane's controls and run bookkeeping as a resumable run drives them, and the run markers
 * the queue drain reads for a conversation the pane may leave mid-run.
 */
export default function useResumablePane({
  run,
  runIndex,
  isAddedRequest,
  setStreamId,
  refreshBalance,
  setIsSubmitting,
  setConversation,
  newConversation,
  setGenerationEpoch,
}: Pick<EventHandlerParams, 'setIsSubmitting' | 'setConversation' | 'newConversation'> & {
  run: ResumableRun;
  runIndex: number;
  isAddedRequest: boolean;
  setStreamId: (streamId: string | null) => void;
  refreshBalance: () => void;
  setGenerationEpoch: ResumablePane['setGenerationEpoch'];
}): { pane: ResumablePane; queue: ResumableQueue } {
  const jotaiStore = useStore();
  const setActiveRunId = useSetRecoilState(store.activeRunFamily(runIndex));
  const setAbortScroll = useSetAtom(abortScrollFamily(runIndex));
  const setSubmission = useSetAtom(submissionByIndex(runIndex));
  const setShowStopButton = useSetAtom(showStopButtonByIndex(runIndex));

  const publishRunEnd = useSetAtom(runEndByIndex(runIndex));
  const setRunEnd = useCallback(
    (end: RunEnd, options?: { retainDetached?: boolean }) => {
      run.runEndPublished = true;
      /** The run's end reached the drain here, so a marker this pane left for the same run is
       *  settled and must not be resolved a second time on a later visit. A provisional end that
       *  cannot drain the queue keeps the marker, so a later read of history can still settle it. */
      if (end.conversationId != null && options?.retainDetached !== true) {
        const detachedFamily = detachedRunByConvoId(end.conversationId);
        const detached = jotaiStore.get(detachedFamily);
        if (
          detached != null &&
          (end.generationCreatedAt == null ||
            detached.generationCreatedAt === end.generationCreatedAt)
        ) {
          jotaiStore.set(detachedFamily, null);
        }
      }
      publishRunEnd(end);
    },
    [jotaiStore, publishRunEnd, run],
  );
  const setDrainAfterAbort = useSetAtom(drainAfterAbortByIndex(runIndex));
  const clearDrainAfterAbort = useCallback(
    (conversationId: string, generationCreatedAt?: number) => {
      if (generationCreatedAt == null) {
        return;
      }
      setDrainAfterAbort((armed) =>
        clearMatchingDrainAfterAbort(armed, conversationId, generationCreatedAt),
      );
    },
    [setDrainAfterAbort],
  );

  const pane = useMemo<ResumablePane>(
    () => ({
      setIsSubmitting,
      setShowStopButton,
      setSubmission,
      setStreamId,
      setGenerationEpoch,
      setPendingAction: (conversationId, action) =>
        jotaiStore.set(pendingApprovalActionFamily(conversationId), action),
      clearComposerDrafts: (conversationId, options) =>
        clearComposerDrafts(runIndex, conversationId, options),
      publishRunEnd: setRunEnd,
      setAbortScroll,
      setConversation,
      startNewConversation: newConversation
        ? () => newConversation({ template: { conversationId: String(Constants.NEW_CONVO) } })
        : undefined,
      replaceNewConversationUrl,
      renewActiveRun: () => setActiveRunId(v4()),
      runEndTarget: resolveRunEndTarget,
      clearDrainAfterAbort,
      refreshBalance,
      updateConversation: isAddedRequest ? undefined : setConversation,
      resolveDetachedEnd: (conversationId, messages) => {
        const detachedRun = jotaiStore.get(detachedRunByConvoId(conversationId));
        const resolvable =
          detachedRun != null && !isDetachedRunManual(jotaiStore.get, conversationId, detachedRun);
        return {
          resolvable,
          end:
            resolvable && messages != null
              ? resolveDetachedRunEnd(conversationId, detachedRun, messages)
              : null,
        };
      },
    }),
    [
      jotaiStore,
      runIndex,
      isAddedRequest,
      setStreamId,
      refreshBalance,
      setIsSubmitting,
      setConversation,
      newConversation,
      setActiveRunId,
      setAbortScroll,
      setSubmission,
      setShowStopButton,
      setGenerationEpoch,
      setRunEnd,
      clearDrainAfterAbort,
    ],
  );
  const queue = useMemo<ResumableQueue>(
    () => ({
      clearSupersededMarkers: (conversationId, isSameGeneration) => {
        const stopFamily = stopRequestedByConvoId(conversationId);
        const stopped = jotaiStore.get(stopFamily);
        if (stopped != null && !isSameGeneration(stopped.generationCreatedAt)) {
          jotaiStore.set(stopFamily, null);
        }
        const detachedFamily = detachedRunByConvoId(conversationId);
        const detached = jotaiStore.get(detachedFamily);
        if (detached != null && !isSameGeneration(detached.generationCreatedAt)) {
          jotaiStore.set(detachedFamily, null);
        }
      },
      isStopped: (conversationId, generationCreatedAt) =>
        isStoppedRun(jotaiStore.get(stopRequestedByConvoId(conversationId)), generationCreatedAt),
      rememberDetachedRun: (conversationId, detachedRun) =>
        jotaiStore.set(detachedRunByConvoId(conversationId), detachedRun),
    }),
    [jotaiStore],
  );
  return { pane, queue };
}

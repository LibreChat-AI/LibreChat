import { useCallback } from 'react';
import { useStore, useAtomValue } from 'jotai';
import { Constants, isAssistantsEndpoint } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { ChatContract } from './contract';
import {
  activeGenerationCreatedAtByConvoId,
  activeGenerationProtocolVersionByConvoId,
} from '../steer/atoms';
import { stopRequestedByConvoId, drainAfterAbortByIndex, runEndByIndex } from '../steer/queue';
import { resolveAbortSteerTarget, supportsGenerationProtocolV2 } from '../../core';
import useSteerConvert from '../steering/useSteerConvert';
import { useClearSubmissions } from '../submission';
import { useAbortCleanup } from './abort';
import { useChatHost } from './host';

/**
 * Stops the pane's generation. A resumable run is aborted through the host's transport, and the
 * stream's own terminal event cleans up the view; an Assistants run, which has its own abort
 * path in the stream handlers, only clears the pane's submissions.
 */
export function useStopGenerating(
  index: number,
  conversation: TConversation | null,
): ChatContract['stopGenerating'] {
  const { conversationId, endpoint, endpointType } = conversation ?? {};
  const host = useChatHost();
  const abortStream = host.useAbortStream();
  const cache = host.useMessageCache();
  const clearAllSubmissions = useClearSubmissions();
  const convertSteersToQueued = useSteerConvert();
  const { captureSubmission, clearSubmissionsUnlessReplaced } = useAbortCleanup(index);
  const activeGenerationCreatedAt = useAtomValue(
    activeGenerationCreatedAtByConvoId(conversationId ?? Constants.NEW_CONVO),
  );
  const activeGenerationProtocolVersion = useAtomValue(
    activeGenerationProtocolVersionByConvoId(conversationId ?? Constants.NEW_CONVO),
  );

  /** Async abort responses can settle after this pane has moved to another
   * conversation and armed its own interrupt. Clear only the intent owned by
   * the request that produced the response. */
  const queueStore = useStore();
  const clearInterruptDrain = useCallback(
    (convoId: string, generationCreatedAt: number) => {
      const armed = queueStore.get(drainAfterAbortByIndex(index));
      if (
        armed !== false &&
        armed.conversationId === convoId &&
        armed.generationCreatedAt === generationCreatedAt
      ) {
        queueStore.set(drainAfterAbortByIndex(index), false);
      }
    },
    [index, queueStore],
  );

  /** A missing job cannot deliver FINAL, so release its armed interrupt queue. */
  const signalInterruptDrain = useCallback(
    (convoId: string, generationCreatedAt: number, armedConversationId = convoId) => {
      const armed = queueStore.get(drainAfterAbortByIndex(index));
      const runEnd = queueStore.get(runEndByIndex(index));
      const matchesArm =
        armed !== false &&
        armed.conversationId === armedConversationId &&
        armed.generationCreatedAt === generationCreatedAt;
      const alreadySignaled =
        runEnd?.conversationId === convoId && runEnd.generationCreatedAt === generationCreatedAt;
      if (!matchesArm || alreadySignaled) {
        return;
      }
      queueStore.set(runEndByIndex(index), {
        conversationId: convoId,
        outcome: 'aborted',
        endedAt: Date.now(),
        generationCreatedAt,
      });
    },
    [index, queueStore],
  );

  /**
   * Stop generation - for non-assistants endpoints, calls abort endpoint first.
   * The abort endpoint will cause the backend to emit a `done` event with `aborted: true`,
   * which will be handled by the SSE event handler to clean up UI.
   * Assistants endpoint has its own abort mechanism via useEventHandlers.abortConversation.
   */
  return useCallback(async () => {
    const actualEndpoint = endpointType ?? endpoint;
    const isAssistants = isAssistantsEndpoint(actualEndpoint);
    console.log('[useChatHelpers] stopGenerating called', {
      conversationId,
      endpoint,
      endpointType,
      actualEndpoint,
      isAssistants,
    });

    // For non-assistants endpoints (using resumable streams), call abort endpoint first
    if (conversationId && !isAssistants) {
      /** Stop is a generation-scoped mutation. `isSubmitting` becomes true
       * before the start POST returns, so a stale/missing epoch must make this
       * path inert instead of aborting whichever conversation job is current. */
      if (activeGenerationCreatedAt == null) {
        return;
      }
      // The aborted run's final SSE can land (and the interrupt drain can
      // start the NEXT submission) while the abort response is in flight;
      // the fallback clear below must not tear down that new run.
      const submissionAtAbort = captureSubmission();
      const stoppedRun = { generationCreatedAt: activeGenerationCreatedAt };
      const stopFamily = stopRequestedByConvoId(conversationId);
      queueStore.set(stopFamily, stoppedRun);
      try {
        console.log('[useChatHelpers] Calling abort mutation for:', conversationId);
        const response = await abortStream({
          conversationId,
          ...(activeGenerationCreatedAt != null && {
            generationCreatedAt: activeGenerationCreatedAt,
          }),
        });
        console.log('[useChatHelpers] Abort mutation succeeded');
        const canUseV2AbortResponse =
          activeGenerationProtocolVersion === 2 && supportsGenerationProtocolV2(response);
        /** Conversation-scoped active-job ids cannot be removed optimistically:
         * a newer generation may have started while this response was in flight.
         * Refetch instead so that replacement remains represented. */
        cache.refetchActiveJobs();
        if (canUseV2AbortResponse && response?.settled === true) {
          /** Natural completion/error won the terminal CAS, so this request did
           * not emit an abort FINAL and must not release the abort-drain queue.
           * The winning terminal event/status owns reconciliation. A run that
           * completed or failed was not stopped, so its persisted outcome may
           * still drain; one another Stop already aborted stays stopped. */
          clearInterruptDrain(conversationId, activeGenerationCreatedAt);
          if (response.terminalStatus !== 'aborted' && queueStore.get(stopFamily) === stoppedRun) {
            queueStore.set(stopFamily, null);
          }
          cache.refetchMessages(conversationId);
          cache.refetchStreamStatus(conversationId);
          return;
        }
        if (canUseV2AbortResponse && response?.persistenceFailed === true) {
          /** The process was interrupted, but neither a durable terminal
           * payload nor a trustworthy leftover-steer set exists. Keep the SSE
           * submission attached for its reconciliation frame/status retry and
           * do not consume the armed interrupt queue against unknown history. */
          clearInterruptDrain(conversationId, activeGenerationCreatedAt);
          cache.refetchMessages(conversationId);
          cache.refetchStreamStatus(conversationId);
          return;
        }
        // The response's `aborted` field is the RESOLVED job id, authoritative
        // when this turn still holds the `new` placeholder. Chips and the drain
        // signal land where the mounted composer's queue machinery looks, while
        // the parked-copy claim uses the resolved id the server keyed it under.
        const { chipConvoId, claimConvoId } = resolveAbortSteerTarget({
          conversationId,
          resolvedId: response?.aborted,
        });
        /** Keep the submission attached until FINAL/status reconciles history.
         * Clearing on the ACK can close SSE during terminal authorization and
         * strand the preliminary response as an unsaved follow-up parent.
         * Only terminal reconciliation may release the interrupt queue. */
        // Restore uninjected steers from the ACK as well as FINAL. Conversion
        // dedupes by steer id; `claimParked` reconciles the replayable copy.
        if (Array.isArray(response?.pendingSteers)) {
          convertSteersToQueued(chipConvoId, response.pendingSteers, {
            claimParked: true,
            claimConversationId: claimConvoId,
            generationProtocolVersion: canUseV2AbortResponse ? 2 : 1,
          });
        }
      } catch (error) {
        console.error('[useChatHelpers] Abort failed:', error);
        const errorData = (
          error as {
            response?: { data?: { code?: string; generationProtocolVersion?: unknown } };
          } | null
        )?.response?.data;
        const code = errorData?.code;
        if (
          code === 'RUN_REPLACED' &&
          activeGenerationProtocolVersion === 2 &&
          supportsGenerationProtocolV2(errorData)
        ) {
          // This tab targeted an older generation. Do not emit an abort run-end
          // or consume its armed queue against the newer live owner.
          cache.refetchActiveJobs();
          clearSubmissionsUnlessReplaced(submissionAtAbort);
          return;
        }
        const status = (error as { response?: { status?: number } } | null | undefined)?.response
          ?.status;
        if (status === 404) {
          // A missing job cannot still consume the interrupt follow-up. Release
          // the armed queue even if its ordinary terminal frame raced cleanup.
          signalInterruptDrain(conversationId, activeGenerationCreatedAt);
          clearSubmissionsUnlessReplaced(submissionAtAbort);
          return;
        }
        /** A timeout/5xx is an unknown mutation outcome: the job may still be
         * live, or the abort may have committed without its response. Keep the
         * attachment and armed queue parked until SSE/status proves a terminal
         * boundary; firing it now could replace a still-running generation. */
        cache.refetchActiveJobs();
        cache.refetchStreamStatus(conversationId);
      }
    } else {
      // For assistants endpoints, just clear submissions (existing behavior)
      console.log('[useChatHelpers] Assistants endpoint, just clearing submissions');
      clearAllSubmissions();
    }
  }, [
    conversationId,
    endpoint,
    endpointType,
    queueStore,
    activeGenerationCreatedAt,
    activeGenerationProtocolVersion,
    abortStream,
    captureSubmission,
    convertSteersToQueued,
    signalInterruptDrain,
    clearSubmissionsUnlessReplaced,
    clearAllSubmissions,
    cache,
    clearInterruptDrain,
  ]);
}

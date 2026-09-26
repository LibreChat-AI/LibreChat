import { useCallback, useMemo, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import { useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys, isAssistantsEndpoint } from 'librechat-data-provider';
import { useRecoilState, useRecoilValue, useSetRecoilState, useRecoilCallback } from 'recoil';
import type { TMessage, TSubmission } from 'librechat-data-provider';
import type { ChatContract } from './contract';
import {
  useGetStartupConfig,
  useAbortStreamMutation,
  supportsGenerationProtocolV2,
} from '~/data-provider';
import { useLatestMessage, useLatestMessageId } from '~/hooks/Messages/useLatestMessage';
import { siblingIdxFamily, siblingKey } from '~/components/Chat/Messages/Thread/state';
import useChatFunctions from '~/hooks/Chat/useChatFunctions';
import useSteerConvert from '~/hooks/Chat/useSteerConvert';
import { resolveAbortSteerTarget } from '~/utils';
import useNewConvo from '~/hooks/useNewConvo';
import { getMessageCacheIds } from './cache';
import { useAbortCleanup } from './abort';
import store from '~/store';

// this to be set somewhere else
export default function useChatHelpers(index = 0, paramId?: string): ChatContract {
  const clearAllSubmissions = store.useClearSubmissionState();
  const [files, setFiles] = useRecoilState(store.filesByIndex(index));
  const [filesLoading, setFilesLoading] = useState(false);

  const queryClient = useQueryClient();
  /** `mutateAsync` is bound once per observer; the mutation result object is
   * fresh every render and would defeat the context value memo below. */
  const { mutateAsync: abortStream } = useAbortStreamMutation();
  const convertSteersToQueued = useSteerConvert();
  const { captureSubmission, clearSubmissionsUnlessReplaced } = useAbortCleanup(index);

  /** Async abort responses can settle after this pane has moved to another
   * conversation and armed its own interrupt. Clear only the intent owned by
   * the request that produced the response. */
  const clearInterruptDrain = useRecoilCallback(
    ({ snapshot, set }) =>
      (convoId: string, generationCreatedAt: number) => {
        const armed = snapshot.getLoadable(store.drainAfterAbortByIndex(index)).getValue();
        if (
          armed !== false &&
          armed.conversationId === convoId &&
          armed.generationCreatedAt === generationCreatedAt
        ) {
          set(store.drainAfterAbortByIndex(index), false);
        }
      },
    [index],
  );

  /**
   * Interrupt & send fallback: clearing submissions below can tear down the
   * SSE before its aborted-final event is processed, and only that event
   * writes the run-end signal the queue drain consumes. When the one-shot
   * interrupt flag is armed and no run-end has landed yet, write it here from
   * the abort response so the queued follow-up still auto-sends. If the SSE
   * final DOES arrive later, its signal finds the flag already consumed and
   * an `aborted` outcome drains nothing, so there is no double fire.
   */
  const signalInterruptDrain = useRecoilCallback(
    ({ snapshot, set }) =>
      (convoId: string, generationCreatedAt: number, armedConversationId = convoId) => {
        const armed = snapshot.getLoadable(store.drainAfterAbortByIndex(index)).getValue();
        const runEnd = snapshot.getLoadable(store.runEndByIndex(index)).getValue();
        const matchesArm =
          armed !== false &&
          armed.conversationId === armedConversationId &&
          armed.generationCreatedAt === generationCreatedAt;
        const alreadySignaled =
          runEnd?.conversationId === convoId && runEnd.generationCreatedAt === generationCreatedAt;
        if (!matchesArm || alreadySignaled) {
          return;
        }
        set(store.runEndByIndex(index), {
          conversationId: convoId,
          outcome: 'aborted',
          endedAt: Date.now(),
          generationCreatedAt,
        });
      },
    [index],
  );

  const { newConversation } = useNewConvo(index);
  const { useCreateConversationAtom } = store;
  const { conversation, setConversation } = useCreateConversationAtom(index);
  const { conversationId, endpoint, endpointType } = conversation ?? {};
  const activeGenerationCreatedAt = useRecoilValue(
    store.activeGenerationCreatedAtByConvoId(conversationId ?? Constants.NEW_CONVO),
  );
  const activeGenerationProtocolVersion = useRecoilValue(
    store.activeGenerationProtocolVersionByConvoId(conversationId ?? Constants.NEW_CONVO),
  );

  /** Use paramId (from URL) as primary source for query key - this must match what ChatView uses
  Falling back to conversationId (Recoil) only if paramId is not available */
  const queryParam = paramId === 'new' ? paramId : (paramId ?? conversationId ?? '');

  const [isSubmitting, setIsSubmitting] = useRecoilState(store.isSubmittingFamily(index));
  const latestMessage = useLatestMessage(index, queryParam);

  const latestMessageId = useLatestMessageId(index, queryParam) ?? undefined;
  const latestMessageDepth = latestMessage?.depth;
  const latestMessageRef = useRef(latestMessage);
  latestMessageRef.current = latestMessage;

  const setSiblingIdx = useSetAtom(
    siblingIdxFamily(siblingKey(latestMessage?.parentMessageId ?? null)),
  );

  const setMessages = useCallback(
    (messages: TMessage[]) => {
      const messageCacheIds = getMessageCacheIds({ queryParam, conversationId, messages });
      for (const messageCacheId of messageCacheIds) {
        queryClient.setQueryData<TMessage[]>([QueryKeys.messages, messageCacheId], messages);
      }
    },
    [queryParam, queryClient, conversationId],
  );

  const getMessages = useCallback(
    (targetConversationId?: string | null) => {
      return queryClient.getQueryData<TMessage[]>([
        QueryKeys.messages,
        targetConversationId ?? queryParam,
      ]);
    },
    [queryParam, queryClient],
  );

  /* Conversation */
  // const setActiveConvos = useSetRecoilState(store.activeConversations);

  // const setConversation = useCallback(
  //   (convoUpdate: TConversation) => {
  //     _setConversation(prev => {
  //       const { conversationId: convoId } = prev ?? { conversationId: null };
  //       const { conversationId: currentId } = convoUpdate;
  //       if (currentId && convoId && convoId !== 'new' && convoId !== currentId) {
  //         // for now, we delete the prev convoId from activeConversations
  //         const newActiveConvos = { [currentId]: true };
  //         setActiveConvos(newActiveConvos);
  //       }
  //       return convoUpdate;
  //     });
  //   },
  //   [_setConversation, setActiveConvos],
  // );

  const setStoredSubmission = useSetRecoilState(store.submissionByIndex(index));
  const [submittedResponse, setSubmittedResponse] = useState<TMessage>();
  /** Keeps the response `ask` submits, as it submits it; a run restored after a reload sets the
   *  submission elsewhere, so it has no pre-stream response here. */
  const setSubmission = useCallback(
    (submission: TSubmission) => {
      setSubmittedResponse(submission.initialResponse);
      setStoredSubmission(submission);
    },
    [setStoredSubmission],
  );
  const initialResponse = isSubmitting ? submittedResponse : undefined;

  const { ask: _ask, regenerate: _regenerate } = useChatFunctions({
    index,
    files,
    setFiles,
    getMessages,
    setMessages,
    isSubmitting,
    conversation,
    latestMessage,
    setSubmission,
  });

  const askRef = useRef(_ask);
  askRef.current = _ask;
  const ask: typeof _ask = useCallback((...args) => askRef.current(...args), []);

  const regenerateRef = useRef(_regenerate);
  regenerateRef.current = _regenerate;
  const regenerate: typeof _regenerate = useCallback(
    (...args) => regenerateRef.current(...args),
    [],
  );

  const continueGeneration = useCallback(() => {
    const currentLatest = latestMessageRef.current;
    if (!currentLatest) {
      console.error('Failed to regenerate the message: latestMessage not found.');
      return;
    }

    const messages = getMessages();

    const parentMessage = messages?.find(
      (element) => element.messageId == currentLatest.parentMessageId,
    );

    if (parentMessage && parentMessage.isCreatedByUser) {
      ask({ ...parentMessage }, { isContinued: true, isRegenerate: true, isEdited: true });
    } else {
      console.error(
        'Failed to regenerate the message: parentMessage not found, or not created by user.',
      );
    }
  }, [getMessages, ask]);

  /**
   * Stop generation - for non-assistants endpoints, calls abort endpoint first.
   * The abort endpoint will cause the backend to emit a `done` event with `aborted: true`,
   * which will be handled by the SSE event handler to clean up UI.
   * Assistants endpoint has its own abort mechanism via useEventHandlers.abortConversation.
   */
  const stopGenerating = useCallback(async () => {
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
        queryClient.invalidateQueries({ queryKey: [QueryKeys.activeJobs] });
        if (canUseV2AbortResponse && response?.settled === true) {
          /** Natural completion/error won the terminal CAS, so this request did
           * not emit an abort FINAL and must not release the abort-drain queue.
           * The winning terminal event/status owns reconciliation. */
          clearInterruptDrain(conversationId, activeGenerationCreatedAt);
          queryClient.invalidateQueries({
            queryKey: [QueryKeys.messages, conversationId],
            refetchType: 'all',
          });
          queryClient.invalidateQueries({ queryKey: ['streamStatus', conversationId] });
          clearSubmissionsUnlessReplaced(submissionAtAbort);
          return;
        }
        if (canUseV2AbortResponse && response?.persistenceFailed === true) {
          /** The process was interrupted, but neither a durable terminal
           * payload nor a trustworthy leftover-steer set exists. Keep the SSE
           * submission attached for its reconciliation frame/status retry and
           * do not consume the armed interrupt queue against unknown history. */
          clearInterruptDrain(conversationId, activeGenerationCreatedAt);
          queryClient.invalidateQueries({
            queryKey: [QueryKeys.messages, conversationId],
            refetchType: 'all',
          });
          queryClient.invalidateQueries({
            queryKey: ['streamStatus', conversationId],
          });
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
        // Steers the run never injected ride the abort response. Consume them
        // here as well as on the SSE final event: clearing submissions below
        // can close the stream before that event lands, and conversion
        // dedupes by steer id so double delivery is a no-op. `claimParked`
        // reconciles the replayable parked copy if the final raced this response.
        if (Array.isArray(response?.pendingSteers)) {
          convertSteersToQueued(chipConvoId, response.pendingSteers, {
            claimParked: true,
            claimConversationId: claimConvoId,
            generationProtocolVersion: canUseV2AbortResponse ? 2 : 1,
          });
        }
        signalInterruptDrain(chipConvoId, activeGenerationCreatedAt, conversationId);
        // The SSE will receive a `done` event with `aborted: true` and clean up
        // We still clear submissions as a fallback
        clearSubmissionsUnlessReplaced(submissionAtAbort);
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
          queryClient.invalidateQueries({ queryKey: [QueryKeys.activeJobs] });
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
        queryClient.invalidateQueries({ queryKey: [QueryKeys.activeJobs] });
        queryClient.invalidateQueries({ queryKey: ['streamStatus', conversationId] });
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
    activeGenerationCreatedAt,
    activeGenerationProtocolVersion,
    abortStream,
    captureSubmission,
    convertSteersToQueued,
    signalInterruptDrain,
    clearSubmissionsUnlessReplaced,
    clearAllSubmissions,
    queryClient,
    clearInterruptDrain,
  ]);

  const handleStopGenerating = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      stopGenerating();
    },
    [stopGenerating],
  );

  const handleRegenerate = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      const parentMessageId = latestMessageRef.current?.parentMessageId ?? '';
      if (!parentMessageId) {
        console.error('Failed to regenerate the message: parentMessageId not found.');
        return;
      }
      regenerate({ parentMessageId });
    },
    [regenerate],
  );

  const handleContinue = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      continueGeneration();
      setSiblingIdx(0);
    },
    [continueGeneration, setSiblingIdx],
  );

  const [preset, setPreset] = useRecoilState(store.presetByIndex(index));
  const [showPopover, setShowPopover] = useRecoilState(store.showPopoverFamily(index));
  const [abortScroll, setAbortScroll] = useRecoilState(store.abortScrollFamily(index));
  const [optionSettings, setOptionSettings] = useRecoilState(store.optionSettingsFamily(index));

  /** Read once per chat rather than per message row: message rows never unmount, so a
   *  per-row config observer would accumulate for the length of the conversation.
   *  Stays disabled until the config resolves, so a `feedback: false` deployment never
   *  flashes controls whose writes the server rejects. */
  const { data: startupConfig } = useGetStartupConfig();
  const feedbackEnabled = startupConfig != null && startupConfig.interface?.feedback !== false;

  return useMemo(
    (): ChatContract => ({
      newConversation,
      conversation,
      setConversation,
      isSubmitting,
      initialResponse,
      setIsSubmitting,
      getMessages,
      messagesKey: queryParam,
      setMessages,
      setSiblingIdx,
      latestMessageId,
      latestMessageDepth,
      ask,
      index,
      regenerate,
      stopGenerating,
      handleStopGenerating,
      handleRegenerate,
      handleContinue,
      showPopover,
      setShowPopover,
      abortScroll,
      setAbortScroll,
      preset,
      setPreset,
      optionSettings,
      setOptionSettings,
      files,
      setFiles,
      filesLoading,
      setFilesLoading,
      feedbackEnabled,
    }),
    [
      newConversation,
      conversation,
      setConversation,
      isSubmitting,
      initialResponse,
      setIsSubmitting,
      getMessages,
      queryParam,
      setMessages,
      setSiblingIdx,
      latestMessageId,
      latestMessageDepth,
      ask,
      index,
      regenerate,
      stopGenerating,
      handleStopGenerating,
      handleRegenerate,
      handleContinue,
      showPopover,
      setShowPopover,
      abortScroll,
      setAbortScroll,
      preset,
      setPreset,
      optionSettings,
      setOptionSettings,
      files,
      setFiles,
      filesLoading,
      setFilesLoading,
      feedbackEnabled,
    ],
  );
}

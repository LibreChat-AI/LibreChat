import { useMemo, useEffect, useState, useRef, useCallback } from 'react';
import { v4 } from 'uuid';
import { useSetRecoilState } from 'recoil';
import { useStore, useSetAtom } from 'jotai';
import { useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys, dataService } from 'librechat-data-provider';
import { ABORT_SWEEP_STATUSES, selectLocalSteersForQueue } from '@librechat/chat';
import {
  submissionByIndex,
  liveAppliedSteerIdsAtom,
  abortScrollFamily,
  showStopButtonByIndex,
} from '@librechat/chat/react';
import {
  getOptimisticMessages,
  isInitialNewConversation,
  getStreamStartFailureText,
  hydrateSubmissionMessages,
  buildOptimisticConversation,
  ResumableRun,
  documentVisibility,
  attachResumableStream,
  mountSubmission,
  releaseSubmission,
} from '@librechat/chat';
import type {
  TMessage,
  TSubmission,
  TConversation,
  EventSubmission,
} from 'librechat-data-provider';
import type { ResumableHost, ResumableCache } from '@librechat/chat';
import type { QueuedMessageOrigin, DrainAfterAbort, RunEnd } from '~/hooks/Chat/queue';
import type { EventHandlerParams } from './useEventHandlers';
import type { ActiveJobsResponse } from '~/data-provider';
import type { TResData, TFinalResData } from '~/common';
import {
  logger,
  clearComposerDrafts,
  applySteerPart,
  resolveRunEndTarget,
  findSteerMessageIndex,
  applyActivityLabelPart,
  applyReasoningLabel,
  offsetActivityPhaseBoundary,
  findActivityLabelMessageIndex,
  findReasoningLabelMessageIndex,
  appendAppliedSteerIds,
  collectAppliedSteerIds,
  removeConvoFromAllQueries,
  upsertConvoInAllQueries,
  invalidateConversationLists,
  countTrailingOutputChars,
  markStreamStartFailedMetadata,
  insertQueuedOrigin,
} from '~/utils';
import {
  resolveDetachedRunEnd,
  isDetachedRunManual,
  stopRequestedByConvoId,
  detachedRunByConvoId,
  isStoppedRun,
  drainAfterAbortByIndex,
  queuedMessagesByConvoId,
  runEndByIndex,
} from '~/hooks/Chat/queue';
import {
  useGetUserBalance,
  fetchStreamStatus,
  useGetStartupConfig,
  queueTitleGeneration,
  streamStatusQueryKey,
  fetchConversationMessages,
} from '~/data-provider';
import {
  recoveryDispositionsFamily,
  canRestoreRecovery,
  blockRecovery,
} from '~/components/Chat/Steering/recovery';
import { pendingApprovalActionFamily } from '~/components/Chat/approval/state';
import { useChatTransport } from '~/Providers/ChatTransportContext';
import { reopenTermsOnRefusal } from '~/utils/terms';
import { useAuthContext } from '~/hooks/AuthContext';
import { fetchConvoSnapshot } from '~/utils/convos';
import useEventHandlers from './useEventHandlers';
import { useFileMapContext } from '~/Providers';
import useUsageHandler from './useUsageHandler';
import useLocalize from '~/hooks/useLocalize';
import useSteerState from './steer';
import store from '~/store';

type ChatHelpers = Pick<
  EventHandlerParams,
  'setMessages' | 'getMessages' | 'setConversation' | 'setIsSubmitting' | 'newConversation'
>;

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

const getStreamStartFailureData = (errorData?: unknown, termsRefusalText?: string): TResData =>
  ({
    text: termsRefusalText ?? getStreamStartFailureText(errorData),
    metadata: markStreamStartFailedMetadata(),
  }) as unknown as TResData;

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

export { ABORT_SWEEP_STATUSES, selectLocalSteersForQueue };

/**
 * Hook for resumable SSE streams.
 * Separates generation start (POST) from stream subscription (GET EventSource).
 * Supports auto-reconnection with exponential backoff.
 *
 * Key behavior:
 * - Navigation away does NOT abort the generation (just closes SSE)
 * - Only explicit abort (via stop button → backend abort endpoint) stops generation
 * - Backend emits `done` event with `aborted: true` on abort, handled via finalHandler
 */
export default function useResumableSSE(
  submission: TSubmission | null,
  chatHelpers: ChatHelpers,
  isAddedRequest = false,
  runIndex = 0,
) {
  const [run] = useState(() => new ResumableRun());
  const jotaiStore = useStore();
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const setActiveRunId = useSetRecoilState(store.activeRunFamily(runIndex));

  const { token, isAuthenticated } = useAuthContext();
  const transport = useChatTransport();
  const fileMap = useFileMapContext();
  const fileMapRef = useRef(fileMap);
  fileMapRef.current = fileMap;
  const { setMessages, getMessages, setConversation, setIsSubmitting, newConversation } =
    chatHelpers;

  /**
   * Optimistically add a job ID to the active jobs cache.
   * Called when generation starts.
   */
  const addActiveJob = useCallback(
    (jobId: string) => {
      queryClient.setQueryData<ActiveJobsResponse>([QueryKeys.activeJobs], (old) => ({
        activeJobIds: [...new Set([...(old?.activeJobIds ?? []), jobId])],
      }));
    },
    [queryClient],
  );

  /**
   * Optimistically remove a job ID from the active jobs cache.
   * Called when generation completes, aborts, or errors.
   */
  const removeActiveJob = useCallback(
    (jobId: string) => {
      queryClient.setQueryData<ActiveJobsResponse>([QueryKeys.activeJobs], (old) => ({
        activeJobIds: (old?.activeJobIds ?? []).filter((id) => id !== jobId),
      }));
    },
    [queryClient],
  );

  const addOptimisticConversation = useCallback(
    (conversationId: string, currentSubmission: TSubmission): TSubmission => {
      if (!isInitialNewConversation(currentSubmission)) {
        return currentSubmission;
      }

      const optimisticConversation = buildOptimisticConversation(currentSubmission, conversationId);
      const optimisticMessages = getOptimisticMessages(
        currentSubmission,
        conversationId,
        getMessages(),
      );

      queryClient.setQueryData<TConversation>(
        [QueryKeys.conversation, conversationId],
        (current) => current ?? optimisticConversation,
      );
      queryClient.setQueryData<TMessage[]>(
        [QueryKeys.messages, conversationId],
        optimisticMessages,
      );
      queryClient.setQueryData<TMessage[]>(
        [QueryKeys.messages, Constants.NEW_CONVO],
        optimisticMessages,
      );
      upsertConvoInAllQueries(queryClient, optimisticConversation);

      return hydrateSubmissionMessages(currentSubmission, conversationId);
    },
    [getMessages, queryClient],
  );

  const resumableCache = useMemo<ResumableCache>(
    () => ({
      invalidateMessages: (conversationId, refetch) =>
        queryClient.invalidateQueries({
          queryKey: [QueryKeys.messages, conversationId],
          refetchType: refetch,
        }),
      fetchMessages: (conversationId, fallback) =>
        queryClient.fetchQuery<TMessage[]>({
          queryKey: [QueryKeys.messages, conversationId],
          ...(fallback === true && {
            // The first stream can finish before CREATED mounts the saved-chat query.
            queryFn: () => fetchConversationMessages(conversationId),
          }),
        }),
      refreshConversation: (conversationId) =>
        queryClient.invalidateQueries({
          queryKey: [QueryKeys.conversation, conversationId],
          refetchType: 'all',
        }),
      refreshConversationLists: () => invalidateConversationLists(queryClient),
      refreshPinnedConversations: () =>
        queryClient.invalidateQueries({ queryKey: [QueryKeys.pinnedConversations] }),
      setStreamStatus: (conversationId, status) =>
        queryClient.setQueryData(streamStatusQueryKey(conversationId), status),
      removeStreamStatus: (conversationId) =>
        queryClient.removeQueries({ queryKey: streamStatusQueryKey(conversationId) }),
      invalidateStreamStatus: (conversationId) =>
        queryClient.invalidateQueries({ queryKey: streamStatusQueryKey(conversationId) }),
      addActiveJob,
      removeActiveJob,
      fetchConversation: (conversationId) =>
        fetchConvoSnapshot(queryClient, conversationId, () =>
          dataService.getConversationById(conversationId),
        ),
      setConversation: (conversationId, conversation) =>
        queryClient.setQueryData([QueryKeys.conversation, conversationId], conversation),
      upsertConversation: (conversation) =>
        upsertConvoInAllQueries(queryClient, conversation, true, 'snapshot'),
      removeConversation: (conversationId) =>
        removeConvoFromAllQueries(queryClient, conversationId),
      getConversation: (conversationId) =>
        queryClient.getQueryData<TConversation>([QueryKeys.conversation, conversationId]),
      removeConversationQueries: (conversationId) => {
        queryClient.removeQueries({ queryKey: [QueryKeys.conversation, conversationId] });
        queryClient.removeQueries({ queryKey: [QueryKeys.messages, conversationId] });
      },
      queueTitleGeneration,
      addOptimisticConversation,
    }),
    [addActiveJob, addOptimisticConversation, queryClient, removeActiveJob],
  );
  const [_completed, setCompleted] = useState(new Set());
  const [streamId, setStreamId] = useState<string | null>(null);
  const setAbortScroll = useSetAtom(abortScrollFamily(runIndex));
  const setSubmission = useSetAtom(submissionByIndex(runIndex));
  const setShowStopButton = useSetAtom(showStopButtonByIndex(runIndex));
  const setLiveAppliedSteerIds = useSetAtom(liveAppliedSteerIdsAtom);

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

  const {
    resolveSteerChip,
    updateSteerChips,
    seedSteerChips,
    settleAppliedSteerParts,
    convertSteersToQueued,
    convertLocalSteersToQueued,
    updateActiveGenerationCreatedAt,
  } = useSteerState();

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

  const {
    stepHandler: rawStepHandler,
    finalHandler,
    errorHandler,
    clearStepMaps,
    messageHandler,
    contentHandler,
    createdHandler,
    titleHandler,
    syncStepMessage,
    prunePtcTraces,
    attachmentHandler,
    resetContentHandler,
    flushPendingDeltas,
  } = useEventHandlers({
    setMessages,
    getMessages,
    setCompleted,
    isAddedRequest,
    runIndex,
    setConversation,
    setIsSubmitting,
    newConversation,
    setShowStopButton,
  });

  /**
   * Run steps and activity labels must resolve indices in ONE space, and the
   * resume SYNC boundary that invalidates the edit prefix is owned here, so
   * this transport stamps its cleared state onto every dispatched
   * submission. `useStepHandler` reads the flag (alongside the captured
   * `editPrefixLength`) instead of measuring the live
   * `initialResponse.content`, which SYNC replaces with the server's
   * completion-local snapshot.
   *
   * Only allocates once the prefix is actually cleared; before that, and on
   * the non-resumable transport, the submission passes through untouched.
   */
  const stepHandler = useCallback(
    (...[event, submission]: Parameters<typeof rawStepHandler>) => {
      const eventSubmission = run.editPrefixCleared
        ? ({ ...submission, editPrefixCleared: true } as EventSubmission)
        : submission;
      rawStepHandler(event, eventSubmission);
      if (eventSubmission.editPrefixFirstPartFolded === true) {
        run.editPrefixFirstPartFolded = true;
      }
    },
    [rawStepHandler, run],
  );

  const { data: startupConfig } = useGetStartupConfig();
  const balanceQuery = useGetUserBalance({
    enabled: !!isAuthenticated && startupConfig?.balance?.enabled,
  });
  const {
    bindResponse,
    contextHandler,
    usageHandler,
    tapStream,
    tapContent,
    finalizeUsage,
    backfillUsage,
    resetLive,
    seedLive,
  } = useUsageHandler();

  /**
   * Subscribe to stream via SSE library (supports custom headers)
   * Follows same auth pattern as useSSE
   * @param isResume - If true, adds ?resume=true to trigger sync event from server
   */
  const buildHost = useCallback(
    (): ResumableHost => ({
      logger,
      visibility: documentVisibility,
      fetchStatus: fetchStreamStatus,
      subscribe: (next) => attachResumableStream(run, buildHost(), next),
      cache: resumableCache,
      queue: {
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
      },
      pane: {
        setIsSubmitting,
        setShowStopButton,
        setSubmission,
        setStreamId,
        setGenerationEpoch: updateActiveGenerationCreatedAt,
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
        refreshBalance: () => {
          (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();
        },
        updateConversation: isAddedRequest ? undefined : setConversation,
        resolveDetachedEnd: (conversationId, messages) => {
          const detachedRun = jotaiStore.get(detachedRunByConvoId(conversationId));
          const resolvable =
            detachedRun != null &&
            !isDetachedRunManual(jotaiStore.get, conversationId, detachedRun);
          return {
            resolvable,
            end:
              resolvable && messages != null
                ? resolveDetachedRunEnd(conversationId, detachedRun, messages)
                : null,
          };
        },
      },
      steers: {
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
      },
      events: {
        stepHandler,
        showStartFailure: (failedSubmission, errorData, reason) => {
          let text: string | undefined;
          if (reason === 'recovery_held') {
            text = localize('com_ui_steer_recovery_held');
          } else if (reopenTermsOnRefusal(queryClient, errorData)) {
            text = localize('com_error_terms_not_accepted');
          }
          errorHandler({
            data: getStreamStartFailureData(errorData, text),
            submission: failedSubmission as EventSubmission,
          });
        },
        finalHandler: (data, finalSubmission) =>
          finalHandler(data as TFinalResData, finalSubmission),
        createdHandler,
        attachmentHandler,
        titleHandler,
        contentHandler,
        messageHandler,
        prunePtcTraces,
        resetContentHandler,
        syncStepMessage,
        clearStepMaps,
        flushPendingDeltas,
        resetLive,
        showError: (text, errorSubmission) =>
          errorHandler({
            data: { text } as unknown as Parameters<typeof errorHandler>[0]['data'],
            submission: errorSubmission as EventSubmission,
          }),
      },
      messages: { get: getMessages, set: setMessages },
      usage: {
        bindResponse,
        contextHandler,
        usageHandler,
        tapStream,
        tapContent,
        finalizeUsage,
        backfillUsage,
        seedLiveFromContent: (content, usageSubmission) =>
          seedLive(countTrailingOutputChars(content), usageSubmission),
      },
      stream: transport.stream({ token }),
      start: transport.start,
      exposeDebugControls: import.meta.env.DEV
        ? ({ killNetwork, closeClean }) => {
            // Debug hooks for testing reconnection vs clean close behavior (dev only)
            const debugWindow = window as Window & {
              __killNetwork?: () => void;
              __closeClean?: () => void;
            };
            debugWindow.__killNetwork = killNetwork;
            debugWindow.__closeClean = closeClean;
          }
        : undefined,
      parts: {
        applySteer: applySteerPart,
        findSteerTarget: findSteerMessageIndex,
        applyActivityLabel: applyActivityLabelPart,
        findActivityLabelTarget: findActivityLabelMessageIndex,
        offsetActivityPhaseBoundary,
        applyReasoningLabel,
        findReasoningLabelTarget: findReasoningLabelMessageIndex,
      },
    }),
    [
      run,
      newConversation,
      localize,
      queryClient,
      restoreQueuedSubmission,
      resumableCache,
      isAddedRequest,
      setConversation,
      runIndex,
      token,
      transport,
      setAbortScroll,
      setActiveRunId,
      setShowStopButton,
      finalHandler,
      createdHandler,
      attachmentHandler,
      titleHandler,
      stepHandler,
      contentHandler,
      resetContentHandler,
      syncStepMessage,
      prunePtcTraces,
      clearStepMaps,
      messageHandler,
      errorHandler,
      flushPendingDeltas,
      setIsSubmitting,
      getMessages,
      setMessages,
      startupConfig?.balance?.enabled,
      balanceQuery,
      bindResponse,
      contextHandler,
      usageHandler,
      tapStream,
      tapContent,
      finalizeUsage,
      backfillUsage,
      resetLive,
      seedLive,
      setRunEnd,
      clearDrainAfterAbort,
      resolveSteerChip,
      setLiveAppliedSteerIds,
      updateSteerChips,
      seedSteerChips,
      settleAppliedSteerParts,
      convertSteersToQueued,
      convertLocalSteersToQueued,
      setSubmission,
      updateActiveGenerationCreatedAt,
      jotaiStore,
    ],
  );

  useEffect(() => {
    const host = buildHost();
    if (!submission || Object.keys(submission).length === 0) {
      releaseSubmission(run, host);
      return;
    }
    return mountSubmission(run, host, submission);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission]);

  return { streamId };
}

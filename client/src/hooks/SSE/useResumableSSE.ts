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
  toStartGenerationError,
  getOptimisticMessages,
  isInitialNewConversation,
  getStreamStartFailureText,
  keepLocalCodeApprovalMode,
  hydrateSubmissionMessages,
  buildOptimisticConversation,
  GENERATION_PROTOCOL_VERSION,
  supportsGenerationProtocolV2,
  ResumableRun,
  documentVisibility,
  attachResumableStream,
  startGeneration,
} from '@librechat/chat';
import type {
  ResumableHost,
  ResumableCache,
  SubscriptionTarget,
  GenerationProtocolVersion,
} from '@librechat/chat';
import type {
  TMessage,
  TSubmission,
  TConversation,
  TPendingSteer,
  EventSubmission,
} from 'librechat-data-provider';
import type { QueuedMessageOrigin, DrainAfterAbort, RunEnd } from '~/hooks/Chat/queue';
import type { ActiveJobsResponse, StreamStatusResponse } from '~/data-provider';
import type { EventHandlerParams } from './useEventHandlers';
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
    }),
    [addActiveJob, queryClient, removeActiveJob],
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

  const subscribeToStream = useCallback(
    (target: SubscriptionTarget) => attachResumableStream(run, buildHost(), target),
    [buildHost, run],
  );

  useEffect(() => {
    if (!submission || Object.keys(submission).length === 0) {
      logger.log('ResumableSSE', 'No submission, cleaning up');
      // Clear reconnect timeout if submission is cleared
      run.clearReconnectTimeout();
      run.stopForegroundReattach?.();
      run.stopForegroundReattach = null;
      // Close SSE but do NOT dispatch cancel - navigation should not abort
      run.stream?.abort();
      run.stream = null;
      setStreamId(null);
      run.reconnectAttempt = 0;
      run.submission = null;
      return;
    }

    const resumableSubmission = submission as TSubmission & {
      resumeStreamId?: string;
      resumeGenerationCreatedAt?: number;
      resumeGenerationProtocolVersion?: GenerationProtocolVersion;
    };
    const resumeStreamId = resumableSubmission.resumeStreamId;
    const resumeGenerationCreatedAt = resumableSubmission.resumeGenerationCreatedAt;
    const resumeGenerationProtocolVersion =
      resumableSubmission.resumeGenerationProtocolVersion ?? 1;
    logger.log('ResumableSSE', 'Effect triggered', {
      conversationId: submission.conversation?.conversationId,
      hasResumeStreamId: !!resumeStreamId,
      resumeStreamId,
      userMessageId: submission.userMessage?.messageId,
    });

    run.submission = submission;
    run.runEndPublished = false;
    run.identityConfirmed = false;
    run.subscribedEpoch = null;
    if (submission.conversation?.conversationId != null) {
      /** A different run starting here owns the conversation's end from now on: an earlier run
       *  this pane left is superseded, and a Stop belonged to that earlier run. Reattaching to
       *  the same generation keeps both, since that run's end is still owed and it was stopped. */
      const startingConvoId = submission.conversation.conversationId;
      const sameGeneration = (generationCreatedAt?: number) =>
        resumeStreamId != null &&
        resumeGenerationCreatedAt != null &&
        generationCreatedAt === resumeGenerationCreatedAt;
      const stopFamily = stopRequestedByConvoId(startingConvoId);
      const stopped = jotaiStore.get(stopFamily);
      if (stopped != null && !sameGeneration(stopped.generationCreatedAt)) {
        jotaiStore.set(stopFamily, null);
      }
      const detachedFamily = detachedRunByConvoId(startingConvoId);
      const detached = jotaiStore.get(detachedFamily);
      if (detached != null && !sameGeneration(detached.generationCreatedAt)) {
        jotaiStore.set(detachedFamily, null);
      }
    }
    const startController = new AbortController();
    const { signal } = startController;
    const isCurrentEffect = () => !signal.aborted && run.submission === submission;

    const initStream = async () => {
      if (!isCurrentEffect()) {
        return;
      }

      bindResponse(submission);
      setIsSubmitting(true);
      /** Starting a new generation is the one interval where `isSubmitting`
       *  is true but no generation epoch exists yet. Clear any prior epoch and
       *  withhold live Stop/steer controls; the composer can still queue input.
       *  subscribeToStream exposes controls once the POST/resume installs the
       *  server-provided epoch. */
      const submissionConversationId =
        submission.conversation?.conversationId ?? Constants.NEW_CONVO;
      if (!resumeStreamId || resumeGenerationCreatedAt == null) {
        updateActiveGenerationCreatedAt(resumeStreamId ?? submissionConversationId, null);
      }
      setShowStopButton(false);

      if (resumeStreamId) {
        if (!isCurrentEffect()) {
          return;
        }
        // Resume: just subscribe to existing stream, don't start new generation
        logger.log('ResumableSSE', 'Resuming existing stream:', resumeStreamId);
        setStreamId(resumeStreamId);
        // Optimistically add to active jobs (in case it's not already there)
        addActiveJob(resumeStreamId);
        subscribeToStream({
          streamId: resumeStreamId,
          submission,
          isResume: true,
          generationCreatedAt: resumeGenerationCreatedAt,
          generationProtocolVersion: resumeGenerationProtocolVersion,
          signal,
        });
      } else {
        // New generation: start and then subscribe
        logger.log('ResumableSSE', 'Starting NEW generation');
        const startResult = await startGeneration(run, buildHost(), submission, signal);
        if (!isCurrentEffect()) {
          return;
        }
        if (startResult) {
          let replacementStart = startResult.status === 'replaced' ? startResult : null;
          let knownReplacementStatus: StreamStatusResponse | null = null;

          if (startResult.status === 'predecessor_mismatch') {
            const expectedPredecessorCreatedAt = submission.expectedPredecessorCreatedAt;
            let refreshedStatus: StreamStatusResponse | null = null;
            try {
              refreshedStatus = await fetchStreamStatus(startResult.conversationId);
              if (!isCurrentEffect()) {
                return;
              }
            } catch (error) {
              if (!isCurrentEffect()) {
                return;
              }
              logger.warn('ResumableSSE', 'Could not refresh predecessor mismatch status', {
                conversationId: startResult.conversationId,
                error,
              });
            }
            if (!isCurrentEffect()) {
              return;
            }

            const reportedReplacement =
              startResult.active === true &&
              startResult.generationCreatedAt != null &&
              startResult.generationCreatedAt !== expectedPredecessorCreatedAt;

            if (
              refreshedStatus?.active === true &&
              supportsGenerationProtocolV2(refreshedStatus) &&
              typeof refreshedStatus.streamId === 'string' &&
              refreshedStatus.streamId.length > 0 &&
              refreshedStatus.createdAt != null &&
              refreshedStatus.createdAt !== expectedPredecessorCreatedAt
            ) {
              replacementStart = {
                status: 'replaced',
                streamId: refreshedStatus.streamId,
                conversationId: startResult.conversationId,
                generationCreatedAt: refreshedStatus.createdAt,
                generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
              };
              knownReplacementStatus = refreshedStatus;
              restoreQueuedSubmission(submission, refreshedStatus.createdAt);
            } else if (reportedReplacement) {
              /** The atomic 409 is itself authoritative at admission time.
               * Status publication can lag that response, so retain its exact
               * epoch as a minimal handoff snapshot; the fenced SSE attach can
               * reconcile if the replacement finishes in the meantime. */
              replacementStart = {
                status: 'replaced',
                streamId: startResult.streamId,
                conversationId: startResult.conversationId,
                generationCreatedAt: startResult.generationCreatedAt!,
                generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
              };
              knownReplacementStatus = {
                active: true,
                status: 'running',
                streamId: startResult.streamId,
                createdAt: startResult.generationCreatedAt,
                generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
              };
              restoreQueuedSubmission(submission, startResult.generationCreatedAt!);
            } else {
              /** No different live epoch is proven. Reconcile away the
               * optimistic C rows, but publish no run-end: doing so would
               * immediately drain and re-send the just-restored queue item. */
              const terminalWinnerCreatedAt =
                refreshedStatus?.createdAt ?? startResult.generationCreatedAt;
              if (terminalWinnerCreatedAt != null) {
                restoreQueuedSubmission(submission, terminalWinnerCreatedAt);
              }
              if (refreshedStatus != null) {
                queryClient.setQueryData(
                  streamStatusQueryKey(startResult.conversationId),
                  refreshedStatus,
                );
              } else {
                queryClient.invalidateQueries({
                  queryKey: streamStatusQueryKey(startResult.conversationId),
                });
              }
              try {
                await queryClient.invalidateQueries({
                  queryKey: [QueryKeys.messages, startResult.conversationId],
                  refetchType: 'all',
                });
                if (!isCurrentEffect()) {
                  return;
                }
                await queryClient.invalidateQueries({
                  queryKey: [QueryKeys.conversation, startResult.conversationId],
                  refetchType: 'all',
                });
                if (!isCurrentEffect()) {
                  return;
                }
                await invalidateConversationLists(queryClient);
                if (!isCurrentEffect()) {
                  return;
                }
                await queryClient.invalidateQueries({ queryKey: [QueryKeys.pinnedConversations] });
                if (!isCurrentEffect()) {
                  return;
                }
              } catch (error) {
                if (!isCurrentEffect()) {
                  return;
                }
                logger.warn('ResumableSSE', 'Could not reconcile predecessor mismatch history', {
                  conversationId: startResult.conversationId,
                  error,
                });
              }
              clearDrainAfterAbort(startResult.conversationId, expectedPredecessorCreatedAt);
              run.submission = null;
              setIsSubmitting(false);
              setShowStopButton(false);
              setSubmission(null);
              return;
            }
          }

          if (replacementStart != null) {
            /** This POST belongs to an older optimistic submission, while the
             * conversation-scoped stream id now belongs to a newer generation.
             * Never attach A's submission directly to B. Discover B's
             * authoritative resume snapshot, refresh durable history, then let
             * useResumeOnLoad construct a new epoch-fenced submission. */
            const replacementStatus =
              knownReplacementStatus ??
              (await fetchStreamStatus(replacementStart.conversationId).catch((error) => {
                if (!isCurrentEffect()) {
                  return null;
                }
                logger.warn('ResumableSSE', 'Could not discover replacement start generation', {
                  conversationId: replacementStart.conversationId,
                  generationCreatedAt: replacementStart.generationCreatedAt,
                  error,
                });
                return null;
              }));
            if (!isCurrentEffect()) {
              return;
            }
            if (
              replacementStatus?.active === true &&
              supportsGenerationProtocolV2(replacementStatus) &&
              replacementStatus.streamId === replacementStart.streamId &&
              replacementStatus.createdAt === replacementStart.generationCreatedAt
            ) {
              const startedAsNewConvo = isInitialNewConversation(submission);
              try {
                await queryClient.invalidateQueries({
                  queryKey: [QueryKeys.messages, replacementStart.conversationId],
                  refetchType: 'all',
                });
                if (!isCurrentEffect()) {
                  return;
                }
                await queryClient.invalidateQueries({
                  queryKey: [QueryKeys.conversation, replacementStart.conversationId],
                  refetchType: 'all',
                });
                if (!isCurrentEffect()) {
                  return;
                }
                await invalidateConversationLists(queryClient);
                if (!isCurrentEffect()) {
                  return;
                }
                await queryClient.invalidateQueries({ queryKey: [QueryKeys.pinnedConversations] });
                if (!isCurrentEffect()) {
                  return;
                }
              } catch (error) {
                if (!isCurrentEffect()) {
                  return;
                }
                logger.warn('ResumableSSE', 'Could not refresh replacement generation history', {
                  conversationId: replacementStart.conversationId,
                  error,
                });
              }
              const authoritativeConversation = queryClient.getQueryData<TConversation>([
                QueryKeys.conversation,
                replacementStart.conversationId,
              ]);
              if (authoritativeConversation?.conversationId === replacementStart.conversationId) {
                const localConversationId = isInitialNewConversation(submission)
                  ? Constants.NEW_CONVO
                  : replacementStart.conversationId;
                setConversation?.((current) =>
                  keepLocalCodeApprovalMode(
                    authoritativeConversation,
                    current,
                    localConversationId,
                  ),
                );
              }
              queryClient.setQueryData(streamStatusQueryKey(replacementStart.conversationId), {
                ...replacementStatus,
                generationHandoff: true,
              });
              updateActiveGenerationCreatedAt(
                replacementStart.conversationId,
                replacementStart.generationCreatedAt,
                undefined,
                replacementStart.generationProtocolVersion,
              );
              addActiveJob(replacementStart.streamId);
              if (startedAsNewConvo) {
                run.optimisticStreamIds.add(replacementStart.streamId);
                updateActiveGenerationCreatedAt(
                  Constants.NEW_CONVO,
                  replacementStart.generationCreatedAt,
                  undefined,
                  replacementStart.generationProtocolVersion,
                );
                replaceNewConversationUrl(replacementStart.conversationId);
              }
              seedSteerChips(
                replacementStart.conversationId,
                (replacementStatus.resumeState?.pendingSteers ?? []) as TPendingSteer[],
                replacementStart.generationCreatedAt,
                replacementStart.generationProtocolVersion,
              );
              settleAppliedSteerParts(
                replacementStart.conversationId,
                replacementStatus.resumeState?.aggregatedContent ??
                  replacementStatus.aggregatedContent,
              );
              run.replacementHandoff = true;
              run.submission = null;
              setIsSubmitting(true);
              setShowStopButton(true);
              setSubmission(null);
              return;
            }

            /** The server reported a replacement but its authoritative status
             * could not be confirmed. Drop A without ever attaching it to B;
             * leave history/status invalidated so navigation/reload can recover,
             * and keep any queued text parked (non-completed outcome). */
            queryClient.invalidateQueries({
              queryKey: streamStatusQueryKey(replacementStart.conversationId),
            });
            queryClient.invalidateQueries({
              queryKey: [QueryKeys.messages, replacementStart.conversationId],
            });
            clearDrainAfterAbort(
              replacementStart.conversationId,
              replacementStart.generationCreatedAt,
            );
            setIsSubmitting(false);
            setShowStopButton(false);
            setRunEnd({
              conversationId: replacementStart.conversationId,
              outcome: 'error',
              endedAt: run.scheduler.now(),
              generationCreatedAt: replacementStart.generationCreatedAt,
            });
            setSubmission(null);
            return;
          }
          if (startResult.status === 'predecessor_mismatch') {
            // Every mismatch path above either hands off or reconciles.
            return;
          }
          if (startResult.status === 'settled') {
            const settledConversationId = startResult.conversationId;
            const startedAsNewConvo = isInitialNewConversation(submission);
            let persistedConversation: TConversation | undefined;
            let conversationLookup: 'found' | 'not_found' | 'inconclusive' = 'inconclusive';
            try {
              persistedConversation = await fetchConvoSnapshot(
                queryClient,
                settledConversationId,
                () => dataService.getConversationById(settledConversationId),
              );
              if (!isCurrentEffect()) {
                return;
              }
              conversationLookup = 'found';
            } catch (error) {
              if (!isCurrentEffect()) {
                return;
              }
              conversationLookup =
                toStartGenerationError(error)?.response?.status === 404
                  ? 'not_found'
                  : 'inconclusive';
              logger.warn('ResumableSSE', 'Could not load settled generation conversation', {
                conversationId: settledConversationId,
                conversationLookup,
                error,
              });
            }

            if (persistedConversation != null) {
              /** The persisted copy carries the mode the settled turn started
               *  with; a pick made while the start was pending is newer. The
               *  live conversation still holds the new-chat id here because no
               *  stream event ran for this turn. */
              const settledCopy = persistedConversation;
              const localConversationId = startedAsNewConvo
                ? Constants.NEW_CONVO
                : settledConversationId;
              const conversationRecord = keepLocalCodeApprovalMode(
                settledCopy,
                queryClient.getQueryData<TConversation>([
                  QueryKeys.conversation,
                  settledConversationId,
                ]),
                settledConversationId,
              );
              queryClient.setQueryData(
                [QueryKeys.conversation, settledConversationId],
                conversationRecord,
              );
              upsertConvoInAllQueries(queryClient, conversationRecord, true, 'snapshot');
              setConversation?.((current) =>
                keepLocalCodeApprovalMode(settledCopy, current, localConversationId),
              );
              if (startedAsNewConvo) {
                replaceNewConversationUrl(settledConversationId);
              }
            }

            try {
              await queryClient.invalidateQueries({
                queryKey: [QueryKeys.messages, settledConversationId],
                refetchType: 'all',
              });
              if (!isCurrentEffect()) {
                return;
              }
              await queryClient.invalidateQueries({
                queryKey: [QueryKeys.conversation, settledConversationId],
                refetchType: 'all',
              });
              if (!isCurrentEffect()) {
                return;
              }
              await invalidateConversationLists(queryClient);
              if (!isCurrentEffect()) {
                return;
              }
              await queryClient.invalidateQueries({ queryKey: [QueryKeys.pinnedConversations] });
              if (!isCurrentEffect()) {
                return;
              }
            } catch (error) {
              if (!isCurrentEffect()) {
                return;
              }
              logger.warn('ResumableSSE', 'Could not refresh settled generation history', {
                conversationId: settledConversationId,
                error,
              });
            }

            if (conversationLookup === 'not_found' && startedAsNewConvo) {
              /** A failed/early-aborted first turn can settle without ever
               * creating a conversation. Never mint A's optimistic rows here:
               * prune any partial cache and return to `/c/new` instead of
               * leaving a phantom chat/URL. */
              removeConvoFromAllQueries(queryClient, settledConversationId);
              queryClient.removeQueries({
                queryKey: [QueryKeys.conversation, settledConversationId],
              });
              queryClient.removeQueries({
                queryKey: [QueryKeys.messages, settledConversationId],
              });
              newConversation?.({
                template: { conversationId: String(Constants.NEW_CONVO) },
              });
            }
            if (conversationLookup === 'inconclusive') {
              /** A network/5xx lookup cannot prove the conversation is absent.
               * Preserve its optimistic/cache state for a later refetch and do
               * not navigate or mint a fresh `/c/new` conversation. */
              clearDrainAfterAbort(settledConversationId, submission.expectedPredecessorCreatedAt);
            }
            clearStepMaps();
            setIsSubmitting(false);
            setShowStopButton(false);
            setRunEnd({
              conversationId: settledConversationId,
              outcome: conversationLookup === 'inconclusive' ? 'error' : 'aborted',
              startedAsNewConvo,
              endedAt: run.scheduler.now(),
            });
            setSubmission(null);
            return;
          }
          if (startResult.status !== 'stream') {
            return;
          }
          const {
            streamId: newStreamId,
            resumed,
            generationCreatedAt,
            generationProtocolVersion,
          } = startResult;
          setStreamId(newStreamId);
          // Optimistically add to active jobs
          addActiveJob(newStreamId);
          // Queue title generation if this is a new conversation (first message).
          // Skip temporary conversations: the server never generates titles for
          // them, so polling would 404 indefinitely.
          const isNewConvo = isInitialNewConversation(submission);
          if (isNewConvo && !submission.isTemporary) {
            queueTitleGeneration(newStreamId);
          }
          if (isInitialNewConversation(submission)) {
            run.optimisticStreamIds.add(newStreamId);
            replaceNewConversationUrl(newStreamId);
          }
          const streamSubmission = addOptimisticConversation(newStreamId, submission);
          run.submission = streamSubmission;
          // A deduped retry (status: 'resumed') attaches to an already-running stream, so
          // subscribe with resume=true to replay its state instead of only live events.
          subscribeToStream({
            streamId: newStreamId,
            submission: streamSubmission,
            isResume: resumed,
            generationCreatedAt,
            generationProtocolVersion,
            signal,
          });
        } else {
          logger.error('ResumableSSE', 'Failed to get streamId from startGeneration');
        }
      }
    };

    /* Fire-and-forget, but not silent: this sets the submitting flags before
       it does any work, so a throw would leave the composer generating with no
       stream, no final event and no way back but a reload. */
    initStream().catch((error: unknown) => {
      logger.error('[useResumableSSE] Failed to start the stream', error);
      setIsSubmitting(false);
      setShowStopButton(false);
      setSubmission(null);
    });

    return () => {
      logger.log('ResumableSSE', 'Cleanup - closing SSE, resetting UI state');
      startController.abort();
      // Cleanup on unmount/navigation - close connection but DO NOT abort backend
      // Reset UI state so it doesn't leak to other conversations
      // If user returns to this conversation, useResumeOnLoad will restore the state
      run.clearReconnectTimeout();
      run.cancelRetryFrames();
      run.stopForegroundReattach?.();
      run.stopForegroundReattach = null;
      // Reset reconnect counter before closing (so abort handler doesn't think we're reconnecting)
      run.reconnectAttempt = 0;
      /** The pane is moving off a run that is still generating (another chat, a new chat, or
       *  an unmount): the server keeps going with no subscriber and deletes the job when done,
       *  so no terminal event will reach the queue drain. Remember the run; on return its end is
       *  read from history. Only a run whose identity the server confirmed (its epoch, and the
       *  user message `created` or a resume's sync named) is remembered, and not a regeneration,
       *  a run that already published its end, or one the user stopped. */
      const closing = run.submission;
      const closingConvoId = closing?.conversation?.conversationId;
      const closingUserMessageId = closing?.userMessage?.messageId;
      const generationCreatedAt = run.subscribedEpoch;
      if (
        run.stream != null &&
        run.identityConfirmed &&
        !run.runEndPublished &&
        closing?.isRegenerate !== true &&
        closingConvoId != null &&
        closingConvoId !== Constants.NEW_CONVO &&
        closingUserMessageId != null &&
        generationCreatedAt != null &&
        !isStoppedRun(jotaiStore.get(stopRequestedByConvoId(closingConvoId)), generationCreatedAt)
      ) {
        jotaiStore.set(detachedRunByConvoId(closingConvoId), {
          userMessageId: closingUserMessageId,
          responseMessageId: closing?.initialResponse?.messageId,
          generationCreatedAt,
        });
      }
      run.stream?.abort();
      run.stream = null;
      // Clear handler maps to prevent memory leaks and stale state
      clearStepMaps();
      // Reset UI state on ordinary cleanup. A generation handoff already
      // cached the replacement and must remain non-idle until resume-on-load
      // installs its epoch-fenced submission.
      if (!run.replacementHandoff) {
        setIsSubmitting(false);
        setShowStopButton(false);
      }
      run.replacementHandoff = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission]);

  return { streamId };
}

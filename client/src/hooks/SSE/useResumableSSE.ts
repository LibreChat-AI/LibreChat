import { useMemo, useEffect, useState, useRef, useCallback } from 'react';
import { v4 } from 'uuid';
import { useSetRecoilState } from 'recoil';
import { useStore, useSetAtom } from 'jotai';
import { useQueryClient } from '@tanstack/react-query';
import { liveAppliedSteerIdsAtom } from '@librechat/chat/react';
import { ABORT_SWEEP_STATUSES, selectLocalSteersForQueue } from '@librechat/chat';
import {
  resolveDetachedRunEnd,
  isStoppedRun,
  canRestoreRecovery,
  blockRecovery,
} from '@librechat/chat';
import {
  isDetachedRunManual,
  stopRequestedByConvoId,
  detachedRunByConvoId,
  drainAfterAbortByIndex,
  queuedMessagesByConvoId,
  runEndByIndex,
  recoveryDispositionsFamily,
} from '@librechat/chat/react';
import {
  Constants,
  QueryKeys,
  StepEvents,
  StepTypes,
  SteerEvents,
  dataService,
  ContentTypes,
  ToolCallTypes,
  ActivityLabelEvents,
  ReasoningLabelEvents,
  UsageEvents,
  createPayload,
  ApprovalEvents,
  removeNullishValues,
} from 'librechat-data-provider';
import {
  getStepEventId,
  toStartGenerationError,
  isOAuthStepEvent,
  waitForRetryDelay,
  applyPendingAction,
  getRecoverySteerId,
  getRetryAfterDelay,
  mergeResumeMessages,
  preferDefinedString,
  isServerNotReadyError,
  getOptimisticMessages,
  isResumedStartResponse,
  isSettledStartResponse,
  isRetryableNetworkError,
  isReplacedStartResponse,
  getResumeMessageIndexes,
  countTaggedApprovalParts,
  isInitialNewConversation,
  getStreamStartFailureText,
  keepLocalCodeApprovalMode,
  hydrateSubmissionMessages,
  buildResumeEventSubmission,
  getStartGenerationStreamId,
  buildOptimisticConversation,
  buildCreatedInitialResponse,
  getGenerationProtocolVersion,
  GENERATION_PROTOCOL_VERSION,
  getStartGenerationCreatedAt,
  isUnnegotiatedV2StartControl,
  supportsGenerationProtocolV2,
  findPendingActionMessageIndex,
  START_GENERATION_NETWORK_RETRIES,
  getStartGenerationConversationId,
  getPredecessorMismatchStartResponse,
  START_GENERATION_READINESS_TIMEOUT_MS,
  ResumableRun,
  documentVisibility,
  ResumableSubscription,
  authorizeTerminalTeardown,
  reconcileGenerationLifecycle,
  handleTransportFailure,
  clearPendingApprovalForTerminal,
  clearAttachedGenerationCreatedAt,
} from '@librechat/chat';
import type {
  Agents,
  TMessage,
  ChatEvent,
  TPayload,
  TSubmission,
  TConversation,
  TPendingSteer,
  EventSubmission,
  TSteerAppliedEvent,
  TSteerUpdatedEvent,
  TActivityLabelEvent,
  TReasoningLabelEvent,
  TAttachment,
  TTokenUsageEvent,
  TContextUsageEvent,
} from 'librechat-data-provider';
import type {
  ResumableHost,
  ResumableCache,
  TerminalContext,
  SubscriptionTarget,
  StartGenerationResult,
  GenerationProtocolVersion,
} from '@librechat/chat';
import type { QueuedMessageOrigin, DrainAfterAbort, RunEnd } from '@librechat/chat';
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
  useGetUserBalance,
  fetchStreamStatus,
  useGetStartupConfig,
  queueTitleGeneration,
  streamStatusQueryKey,
  fetchConversationMessages,
} from '~/data-provider';
import { pendingApprovalActionFamily } from '~/components/Chat/approval/state';
import { abortScrollFamily, showStopButtonByIndex } from '~/store/generation';
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

/** The step handler predates the wire types and accepts a narrower payload. */
type StepEvent = Parameters<ReturnType<typeof useEventHandlers>['stepHandler']>[0];

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
  const setSubmission = useSetRecoilState(store.submissionByIndex(runIndex));
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
  const subscribeToStream = useCallback(
    (target: SubscriptionTarget) => {
      /** See `ResumableSubscription.isCurrent` for the fences every callback below checks. */
      if (target.signal?.aborted || run.submission !== target.submission) {
        return;
      }
      const host: ResumableHost = {
        logger,
        visibility: documentVisibility,
        fetchStatus: fetchStreamStatus,
        subscribe: (next) => subscribeToStream(next),
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
          seed: seedSteerChips,
          appliedIds: collectAppliedSteerIds,
          settleApplied: settleAppliedSteerParts,
          convertToQueued: convertSteersToQueued,
          convertLocalToQueued: convertLocalSteersToQueued,
        },
        events: {
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
      };
      const sub = new ResumableSubscription(run, host, target);
      const {
        streamId: currentStreamId,
        isResume,
        generationCreatedAt,
        generationProtocolVersion,
        startedAsNewConversation,
      } = sub;
      run.subscribedEpoch = generationCreatedAt ?? null;
      if (generationCreatedAt != null) {
        updateActiveGenerationCreatedAt(
          currentStreamId,
          generationCreatedAt,
          undefined,
          generationProtocolVersion,
        );
        /** Until CREATED moves the conversation context off `/c/new`, Stop and
         *  approval controls still read the placeholder key. Mirror the exact
         *  epoch there briefly; the server's user-wide fallback plus this fence
         *  can safely resolve the just-started job. */
        if (startedAsNewConversation) {
          updateActiveGenerationCreatedAt(
            Constants.NEW_CONVO,
            generationCreatedAt,
            undefined,
            generationProtocolVersion,
          );
        }
        setShowStopButton(true);
      } else {
        /** Generation-scoped mutations are unsafe until the server supplies
         *  the epoch they must fence against. Keep Stop hidden if an old or
         *  malformed response omitted it. */
        setShowStopButton(false);
      }
      /**
       * A NEW generation starts with its retained prefix intact, so the
       * cleared-prefix state from a previous one must not carry over: the
       * hook outlives any single submission, and a later edited resubmission
       * would otherwise dispatch with no offset and overwrite the content it
       * kept.
       *
       * Keyed on `clientRequestId`, the per-submission uuid. Each of the
       * narrower keys tried before it crossed a real boundary:
       *   - `isResume`: a submission whose POST succeeded but lost its
       *     response retries and returns `resumed: true`, so a NEW generation
       *     arrives in resume mode and skipped the reset.
       *   - the stream id: `request.js` sets `streamId = conversationId`, so
       *     every generation in a conversation shares it.
       *   - the response message id: editing an assistant response reuses
       *     that same id (`editedMessageId`), so re-editing one response
       *     produced the same key twice.
       * `clientRequestId` is minted per submission and forwarded unchanged on
       * retries, which is exactly "new per edit attempt, stable across
       * reconnects".
       */
      const generationId =
        sub.submission.clientRequestId ??
        (sub.submission.initialResponse as TMessage | undefined)?.messageId ??
        currentStreamId;
      run.bindPrefixState(generationId);
      bindResponse(sub.submission);
      const replayPreCreatedStepEvents = () => {
        if (!sub.isCurrent() || sub.preCreatedStepEvents.length === 0) {
          return;
        }

        const submission = sub.liveSubmission() as EventSubmission;
        for (const event of sub.preCreatedStepEvents.splice(0)) {
          stepHandler(event, submission);
        }
      };
      const applyPendingOAuthPrompt = (
        prompt: Agents.PendingMCPOAuthPrompt,
        submission: EventSubmission,
      ) => {
        const toolCall: Agents.ToolCall = {
          id: prompt.toolCallId,
          name: prompt.toolName,
          args: '',
          type: ToolCallTypes.TOOL_CALL,
        };
        const toolCallDelta: Agents.ToolCallChunk = {
          id: prompt.toolCallId,
          name: prompt.toolName,
          args: '',
        };
        stepHandler(
          {
            event: StepEvents.ON_RUN_STEP,
            data: {
              id: prompt.stepId,
              runId: prompt.runId,
              index: prompt.index,
              type: StepTypes.TOOL_CALLS,
              stepDetails: {
                type: StepTypes.TOOL_CALLS,
                tool_calls: [toolCall],
              },
            },
          },
          submission,
        );
        stepHandler(
          {
            event: StepEvents.ON_RUN_STEP_DELTA,
            data: {
              id: prompt.stepId,
              delta: {
                type: StepTypes.TOOL_CALLS,
                tool_calls: [toolCallDelta],
                auth: prompt.authURL,
                expires_at: prompt.expiresAt,
              },
            },
          },
          submission,
        );
      };

      /**
       * Maps a pending action onto the in-flight response message so the
       * approval / ask-user UI renders. Syncs the result back into the step
       * handler's map so subsequent deltas build on the approval-tagged content
       * rather than clobbering it.
       *
       * If the mapping is a no-op (the paused tool-call content part hasn't
       * rendered yet, a pause-before-render race), retry on subsequent frames
       * so the approval still attaches. `ask_user_question` always applies (it
       * appends a synthetic part), so only `tool_approval` ever retries.
       */
      // Keep retrying across frames (not just once): Recoil/React message updates from
      // the preceding created/step events are async and can take several frames under
      // load, so a single retry would drop a valid pause and leave the run with no
      // approval controls. Bounded so a genuinely-absent target can't spin forever.
      const PENDING_ACTION_MAX_RETRY_FRAMES = 120;
      const applyPendingActionToMessages = (pendingAction: Agents.PendingAction, attempt = 0) => {
        if (!sub.isCurrent()) {
          return;
        }
        const pendingConversationId =
          pendingAction.conversationId ??
          sub.submission.conversation?.conversationId ??
          currentStreamId;
        jotaiStore.set(pendingApprovalActionFamily(pendingConversationId), pendingAction);
        const retryNextFrame = () => {
          if (attempt < PENDING_ACTION_MAX_RETRY_FRAMES) {
            run.pendingActionRetry = run.scheduler.requestFrame(() => {
              if (sub.isCurrent()) {
                applyPendingActionToMessages(pendingAction, attempt + 1);
              }
            });
          }
        };
        /** The pause card must attach to the same message state the stream
         * produced: apply any queued delta before reading the cache, or the
         * later flush would clobber the card (and `syncStepMessage` below
         * would sync a pre-delta copy). */
        flushPendingDeltas();
        const messages = getMessages() ?? [];
        const index = findPendingActionMessageIndex(messages, pendingAction);
        if (index < 0) {
          retryNextFrame();
          return;
        }
        const updated = applyPendingAction(messages[index], pendingAction);
        const changed = updated !== messages[index];
        if (changed) {
          const nextMessages = [...messages];
          nextMessages[index] = updated;
          setMessages(nextMessages);
          syncStepMessage(updated);
        }
        // A `tool_approval` pause can carry several `action_requests` whose tool-call
        // parts render on different frames; tagging only the first to arrive would leave
        // late siblings with no approval card, and the resume route then 400s the partial
        // batch ("every paused tool call must be decided"). Keep retrying (bounded) until
        // EVERY paused call is tagged. `ask_user_question` applies its single synthetic
        // part in one shot, so it only needs the original "did anything change" retry.
        if (pendingAction.payload.type === 'tool_approval') {
          const expected = pendingAction.payload.action_requests.length;
          if (countTaggedApprovalParts(updated, pendingAction.actionId) < expected) {
            retryNextFrame();
          }
        } else if (!changed) {
          retryNextFrame();
        }
      };

      const terminal: TerminalContext = {
        sub,
        host,
        applyPendingAction: (action) => applyPendingActionToMessages(action),
      };

      /**
       * The identities this pane may be rendering the in-flight response under
       * before the first run step renames it to the server's pre-allocated id:
       * the submission's placeholder (updated on `created`) and the padded form
       * of the live user message. Read at call time — `created` reassigns both.
       */
      const livePlaceholderIds = () => [
        sub.submission.initialResponse?.messageId,
        sub.userMessage?.messageId ? `${sub.userMessage.messageId}_` : undefined,
      ];

      /**
       * A regenerate seeds the renamed response from `submission.initialResponse`
       * rather than the store tail (an edited resubmission seeds from its
       * content), so a part committed to the placeholder only in the store would
       * be dropped by the first run step's rename. Keep the submission the step
       * handler receives in step with the placeholder this pane mutated.
       */
      const syncSubmissionPlaceholder = (updated: TMessage) => {
        if (updated.messageId !== sub.submission.initialResponse?.messageId) {
          return;
        }
        sub.replaceSubmission({ ...sub.submission, initialResponse: updated });
      };

      /**
       * Edit-and-resubmit keeps the retained prefix on the client while the
       * server indexes only the NEW content, so every server-claimed index —
       * run steps (`useStepHandler`), labels and steers — shifts past it or
       * lands inside the prefix and overwrites kept content. The captured
       * length is used over the live array because a resume sync replaces
       * `initialResponse.content` with the server's completion-local snapshot.
       */
      const editPrefixLength = () =>
        sub.submission.editedContent != null && !run.editPrefixCleared
          ? (sub.submission.editPrefixLength ??
            sub.submission.initialResponse?.content?.length ??
            0)
          : 0;

      /**
       * Places an injected steer part on the in-flight response message and
       * resolves its pending chip. Same bounded next-frame retry as pending
       * actions for the inject-before-render race (the assistant placeholder
       * can land a few frames after the created event under load).
       */
      const applySteerToMessages = (
        event: TSteerAppliedEvent,
        attempt = 0,
        liveSteerIds: string[] = [],
      ) => {
        if (!sub.isCurrent()) {
          return;
        }
        const chipConvoId =
          event.conversationId ?? sub.submission.conversation?.conversationId ?? currentStreamId;
        /** The server's applied event settles ownership immediately. Rendering
         *  the inline part can wait for React to mount the target, but leaving
         *  the chip pending during that wait lets an intervening error/final
         *  convert already-applied words into a duplicate queued message. */
        const firstApplicationIds =
          attempt === 0
            ? (resolveSteerChip(
                chipConvoId,
                event.steerId,
                event.clientSteerId,
                event.part?.quotes,
              ) ?? [])
            : liveSteerIds;
        const retryNextFrame = () => {
          if (attempt < PENDING_ACTION_MAX_RETRY_FRAMES) {
            const frameId = run.scheduler.requestFrame(() => {
              run.steerRetryFrames.delete(frameId);
              if (sub.isCurrent()) {
                applySteerToMessages(event, attempt + 1, firstApplicationIds);
              }
            });
            run.steerRetryFrames.add(frameId);
          }
        };
        /** Same boundary as pending actions: land queued deltas before the
         * steer part is placed and synced. */
        flushPendingDeltas();
        const messages = getMessages() ?? [];
        const index = findSteerMessageIndex(messages, event, livePlaceholderIds());
        if (index < 0) {
          retryNextFrame();
          return;
        }
        const prefixLength = editPrefixLength();
        const updated = applySteerPart(
          messages[index],
          typeof event.index === 'number' && prefixLength > 0
            ? { ...event, index: event.index + prefixLength }
            : event,
        );
        if (updated !== messages[index]) {
          /** Stamped only when the inline part is actually committed, in the
           *  same batch, so its first render sees the flag and plays the
           *  one-shot draw-in (`SteerPart` consumes the id on mount). A
           *  replayed event is referentially stable here and an abandoned
           *  placement never reaches this branch, so neither can strand a
           *  stale id that would animate a historical part on a later visit.
           *  Only the id the part RENDERS with (`part.steerId`) is stamped:
           *  the part consumes exactly that id, so a client alias would sit
           *  in the set forever as dead weight. */
          const renderedSteerId = event.part?.steerId ?? event.steerId;
          if (firstApplicationIds.includes(renderedSteerId)) {
            setLiveAppliedSteerIds((prev) => appendAppliedSteerIds(prev, [renderedSteerId]));
          }
          const nextMessages = [...messages];
          nextMessages[index] = updated;
          setMessages(nextMessages);
          syncStepMessage(updated);
          syncSubmissionPlaceholder(updated);
        }
      };

      /**
       * Places an activity-label part at its claimed content index on the
       * in-flight response message. Fires twice per block (the empty
       * reservation at batch end, the generated label on resolve);
       * `applyActivityLabelPart` is referentially stable on duplicate replays
       * and refuses to overwrite filled text with a stale placeholder. Same
       * bounded next-frame retry as steers for the inject-before-render race.
       */
      const applyActivityLabelToMessages = (event: TActivityLabelEvent, attempt = 0) => {
        if (!sub.isCurrent()) {
          return;
        }
        const retryNextFrame = () => {
          if (attempt < PENDING_ACTION_MAX_RETRY_FRAMES) {
            const frameId = run.scheduler.requestFrame(() => {
              run.activityLabelRetryFrames.delete(frameId);
              if (sub.isCurrent()) {
                applyActivityLabelToMessages(event, attempt + 1);
              }
            });
            run.activityLabelRetryFrames.add(frameId);
          }
        };
        /** Same boundary as pending actions and steers: land queued deltas
         * before the label part is placed and synced, or the later flush
         * would clobber it (and `syncStepMessage` would sync a pre-delta
         * copy back into the step handler's authoritative map). */
        flushPendingDeltas();
        const messages = getMessages() ?? [];
        const index = findActivityLabelMessageIndex(messages, event, livePlaceholderIds());
        if (index < 0) {
          retryNextFrame();
          return;
        }
        /** Edit-and-resubmit replays the kept prefix into the response before
         *  the run starts, and the server indexes only the NEW content, so
         *  run steps offset by that prefix (`useStepHandler`). The label index
         *  is claimed in the same server-side space and needs the identical
         *  shift, or it lands inside the prefix and overwrites kept content.
         *
         *  Uses `editPrefixLength`, captured when the submission was built,
         *  for the same reason `useStepHandler` does: a resume sync replaces
         *  `initialResponse.content` with the server's completion-local
         *  snapshot, so its length no longer describes the retained prefix.
         *  Tool cards and the label heading them must land in one index
         *  space: a label shifting differently from its tools would overwrite
         *  another part, and a gap fill would miss its own reservation and
         *  leave the placeholder pending forever. */
        const prefixLength = editPrefixLength();
        const phasePart = event.part as TActivityLabelEvent['part'] & {
          activity_label_type?: 'phase';
          activity_start_index?: number;
          activity_end_index?: number;
        };
        let offsetEvent = event;
        if (prefixLength > 0) {
          let offsetPart: TActivityLabelEvent['part'] & {
            activity_label_type?: 'phase';
            activity_start_index?: number;
            activity_end_index?: number;
          } = phasePart;
          if (
            phasePart.activity_label_type === 'phase' &&
            typeof phasePart.activity_start_index === 'number'
          ) {
            let activityStartIndex = phasePart.activity_start_index + prefixLength;
            const foldedFirstPart = run.editPrefixFirstPartFolded;
            const targetContent = messages[index]?.content;
            /** The step handler records an actual server-index-zero text/think
             *  merge. An empty +prefix slot is insufficient evidence because
             *  a delayed tool may not have materialized there yet. */
            if (
              phasePart.activity_start_index === 0 &&
              activityStartIndex > 0 &&
              foldedFirstPart &&
              targetContent?.[activityStartIndex - 1] != null
            ) {
              activityStartIndex -= 1;
            }
            offsetPart = {
              ...phasePart,
              activity_start_index: activityStartIndex,
              ...(typeof phasePart.activity_end_index === 'number' && {
                activity_end_index: offsetActivityPhaseBoundary(
                  phasePart.activity_end_index,
                  prefixLength,
                  foldedFirstPart,
                ),
              }),
            };
          }
          offsetEvent = {
            ...event,
            index: event.index + prefixLength,
            part: offsetPart,
          };
        }
        const updated = applyActivityLabelPart(messages[index], offsetEvent);
        if (updated !== messages[index]) {
          const nextMessages = [...messages];
          nextMessages[index] = updated;
          setMessages(nextMessages);
          syncStepMessage(updated);
          syncSubmissionPlaceholder(updated);
        }
      };

      /** Patches a generated title onto its existing reasoning part. */
      const applyReasoningLabelToMessages = (event: TReasoningLabelEvent, attempt = 0) => {
        if (!sub.isCurrent()) {
          return;
        }
        const retryNextFrame = () => {
          if (attempt < PENDING_ACTION_MAX_RETRY_FRAMES) {
            const frameId = run.scheduler.requestFrame(() => {
              run.activityLabelRetryFrames.delete(frameId);
              if (sub.isCurrent()) {
                applyReasoningLabelToMessages(event, attempt + 1);
              }
            });
            run.activityLabelRetryFrames.add(frameId);
          }
        };
        flushPendingDeltas();
        const messages = getMessages() ?? [];
        const messageIndex = findReasoningLabelMessageIndex(messages, event);
        if (messageIndex < 0) {
          retryNextFrame();
          return;
        }
        const prefixLength = editPrefixLength();
        let contentIndex = event.index + prefixLength;
        if (
          prefixLength > 0 &&
          event.index === 0 &&
          run.editPrefixFirstPartFolded &&
          messages[messageIndex]?.content?.[contentIndex - 1]?.type === ContentTypes.THINK
        ) {
          contentIndex -= 1;
        }
        const updated = applyReasoningLabel(messages[messageIndex], {
          ...event,
          index: contentIndex,
        });
        if (updated === messages[messageIndex]) {
          const part = messages[messageIndex]?.content?.[contentIndex];
          if (part?.type !== ContentTypes.THINK && attempt < PENDING_ACTION_MAX_RETRY_FRAMES) {
            retryNextFrame();
          }
          return;
        }
        const nextMessages = [...messages];
        nextMessages[messageIndex] = updated;
        setMessages(nextMessages);
        syncStepMessage(updated);
      };

      logger.log('ResumableSSE', 'Subscribing to stream:', sub.url(), { isResume });
      sub.claim();
      sub.watchForeground();

      const handleOpen = () => {
        if (!sub.isCurrent()) {
          return;
        }
        logger.log('ResumableSSE', 'Stream connected');
        setAbortScroll(false);
        // Restore UI state on successful connection (including reconnection)
        setIsSubmitting(true);
        setShowStopButton(generationCreatedAt != null);
        run.reconnectAttempt = 0;
      };

      const handleFrame = async (event: ChatEvent) => {
        try {
          if (!sub.isCurrent() || sub.finalReceived) {
            return;
          }

          if (event.type === 'final' && event.data.reconcile === true) {
            const { data } = event;
            if (
              generationProtocolVersion !== GENERATION_PROTOCOL_VERSION ||
              !supportsGenerationProtocolV2(data)
            ) {
              logger.warn('ResumableSSE', 'Ignoring unnegotiated lifecycle reconciliation frame');
              return;
            }
            // Synthesized lifecycle frames deliberately carry no ordinary
            // response payload. Reconcile durable history (or hand off to a
            // replacement epoch) instead of passing them to finalHandler.
            sub.finalReceived = true;
            run.cancelSteerRetryFrames();
            void reconcileGenerationLifecycle(terminal, data);
            return;
          }

          if (event.type === 'final') {
            const { data } = event;
            sub.finalReceived = true;
            const finalConvoId =
              data.conversation?.conversationId ??
              sub.submission.conversation?.conversationId ??
              currentStreamId;
            if (
              !(await authorizeTerminalTeardown(terminal, finalConvoId, 'FINAL')) ||
              !sub.isCurrent()
            ) {
              return;
            }
            run.cancelSteerRetryFrames();
            run.clearReconnectTimeout();
            run.reconnectAttempt = 0;
            logger.log('ResumableSSE', 'Received FINAL event', {
              aborted: data.aborted,
              conversationId: data.conversation?.conversationId,
              hasResponseMessage: !!data.responseMessage,
            });
            clearPendingApprovalForTerminal(terminal, finalConvoId);
            clearComposerDrafts(runIndex, sub.submission.conversation?.conversationId, {
              includeNewChatDraft:
                !sub.submission.conversation?.conversationId ||
                sub.submission.conversation.conversationId === Constants.NEW_CONVO ||
                run.optimisticStreamIds.has(currentStreamId) ||
                isInitialNewConversation(sub.submission),
            });
            // A steer-applied event may still be waiting for its next-frame
            // message target when FINAL arrives. Reconcile directly from the
            // authoritative final message before converting leftovers so a
            // late 202 ACK cannot resurrect (or queue) an already-applied steer.
            const finalAppliedSteerIds = new Set(
              collectAppliedSteerIds(data.responseMessage ? [data.responseMessage] : []),
            );
            settleAppliedSteerParts(
              finalConvoId,
              data.responseMessage ? [data.responseMessage] : undefined,
            );
            // Steers the run never injected ride the final event; convert them
            // to queued follow-ups before the run-end signal fires the drain
            // (also resets the applied-id set for the finished run).
            // `claimParked` reconciles the replayable parked copy of the same
            // steers; explicit dismissal or a persisted recovery removes it.
            convertSteersToQueued(
              finalConvoId,
              (generationProtocolVersion === 1 || supportsGenerationProtocolV2(data)) &&
                Array.isArray(data.pendingSteers)
                ? (data.pendingSteers as TPendingSteer[]).filter(
                    (steer) =>
                      !finalAppliedSteerIds.has(steer.steerId) &&
                      (steer.clientSteerId == null ||
                        !finalAppliedSteerIds.has(steer.clientSteerId)),
                  )
                : [],
              {
                claimParked: true,
                generationProtocolVersion,
              },
            );
            // A `failed` chip never reached the server, so it never rides
            // `data.pendingSteers` above; without this it survives a NORMAL
            // completion and renders (with a live Retry) under the NEXT run's
            // reply. Idempotent alongside the call above: both dedupe by id.
            convertLocalSteersToQueued(finalConvoId);
            let finalHandled = false;
            try {
              finalHandler(data as TFinalResData, sub.submission as EventSubmission);
              finalHandled = true;
              finalizeUsage(data, sub.liveSubmission());
            } catch (error) {
              logger.error('ResumableSSE', 'Error in finalHandler:', error);
              setIsSubmitting(false);
              setShowStopButton(false);
            }
            // One-shot run-end signal for the queue drain. Written AFTER
            // finalHandler so `isSubmitting` has flipped false by the time the
            // drain effect observes it (both land in the same Recoil batch).
            // An early-aborted FIRST turn keys under NEW_CONVO: finalHandler
            // restored /c/new, so the optimistic id would strand the queue.
            const runEndTarget = resolveRunEndTarget({
              conversationId: finalConvoId,
              earlyAbort: data.earlyAbort === true,
              startedAsNewConvo: run.optimisticStreamIds.has(currentStreamId),
            });
            let finalOutcome: 'completed' | 'aborted' | 'error' = 'error';
            if (data.aborted === true || data.responseMessage?.unfinished === true) {
              finalOutcome = 'aborted';
            } else if (finalHandled) {
              finalOutcome = 'completed';
            }
            setRunEnd({
              conversationId: runEndTarget.conversationId,
              // A Stop that lands before completion can arrive as a final with
              // `unfinished: true` and no `aborted` flag (request.js's
              // wasAbortedBeforeComplete branch); it must not auto-drain.
              outcome: finalOutcome,
              startedAsNewConvo: runEndTarget.startedAsNewConvo,
              endedAt: run.scheduler.now(),
              generationCreatedAt,
              ...(data.responseMessage?.messageId != null && {
                responseMessageId: data.responseMessage.messageId,
              }),
            });
            // Clear handler maps on stream completion to prevent memory leaks
            clearStepMaps();
            // Optimistically remove from active jobs
            removeActiveJob(currentStreamId);
            clearAttachedGenerationCreatedAt(terminal);
            (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();
            sub.close();
            setStreamId(null);
            run.releaseStream(currentStreamId);
            return;
          }

          if (event.type === 'created') {
            const { data } = event;
            logger.log('ResumableSSE', 'Received CREATED event', {
              messageId: data.message?.messageId,
              conversationId: data.message?.conversationId,
            });
            run.createdStreamIds.add(currentStreamId);
            if (startedAsNewConversation) {
              updateActiveGenerationCreatedAt(Constants.NEW_CONVO, null, generationCreatedAt);
            }
            const runId = v4();
            setActiveRunId(runId);
            sub.userMessage = {
              ...sub.userMessage,
              ...data.message,
              overrideParentMessageId: sub.userMessage.overrideParentMessageId,
            };
            const createdInitialResponse = buildCreatedInitialResponse({
              initialResponse: sub.submission.initialResponse as TMessage,
              userMessage: sub.userMessage,
              isRegenerate: sub.submission.isRegenerate,
            });
            sub.replaceSubmission({
              ...sub.submission,
              userMessage: sub.userMessage,
              initialResponse: createdInitialResponse,
            });
            run.identityConfirmed = true;
            bindResponse(sub.submission);
            createdHandler(data, sub.submission as EventSubmission);
            replayPreCreatedStepEvents();
            return;
          }

          if (event.type === 'attachment' && event.data) {
            attachmentHandler({
              data: event.data as TAttachment,
              submission: sub.submission as EventSubmission,
            });
            return;
          }

          if (event.type === 'title') {
            titleHandler(event.data);
            return;
          }

          if (event.type === 'context_usage') {
            contextHandler(event.data, sub.liveSubmission());
            return;
          }

          if (event.type === 'token_usage') {
            usageHandler(event.data, sub.liveSubmission());
            return;
          }

          if (event.type === 'pending_action') {
            applyPendingActionToMessages(event.data);
            setIsSubmitting(true);
            return;
          }

          if (event.type === 'steer_applied') {
            applySteerToMessages(event.data);
            return;
          }

          if (event.type === 'steer_updated') {
            updateSteerChips(event.data);
            return;
          }

          if (event.type === 'activity_label') {
            applyActivityLabelToMessages(event.data);
            return;
          }

          if (event.type === 'reasoning_label') {
            applyReasoningLabelToMessages(event.data);
            return;
          }

          if (event.type === 'step') {
            const data = event.data as StepEvent;
            if (
              data.event === StepEvents.ON_MESSAGE_DELTA ||
              data.event === StepEvents.ON_REASONING_DELTA
            ) {
              tapStream(data.data, sub.liveSubmission());
            }
            if (!isResume && !run.createdStreamIds.has(currentStreamId)) {
              if (isOAuthStepEvent(data)) {
                sub.preCreatedStepEvents.push(data);
                stepHandler(data, sub.liveSubmission() as EventSubmission);
                return;
              }
              sub.preCreatedStepEvents.push(data);
              return;
            }
            stepHandler(data, sub.liveSubmission() as EventSubmission);
            return;
          }

          if (event.type === 'sync') {
            const { data } = event;
            logger.log('ResumableSSE', 'SYNC received', {
              runSteps: data.resumeState?.runSteps?.length ?? 0,
              pendingEvents: data.pendingEvents?.length ?? 0,
            });

            const runId = v4();
            setActiveRunId(runId);
            /** Keep the current run's preliminary id long enough to replace that optimistic
             *  row in place if this snapshot assigns its durable response id. */
            const preliminaryResponseMessageId = sub.submission.initialResponse?.messageId;
            const currentUserMessageId = sub.submission.userMessage?.messageId;
            const preliminaryUserMessageId =
              currentUserMessageId &&
              (sub.submission.initialResponse?.parentMessageId === currentUserMessageId ||
                preliminaryResponseMessageId === `${currentUserMessageId}_`)
                ? currentUserMessageId
                : undefined;
            const resumeSubmission = buildResumeEventSubmission(
              sub.submission,
              sub.userMessage,
              data.resumeState,
            );
            sub.replaceSubmission(resumeSubmission);
            sub.userMessage = resumeSubmission.userMessage;
            if (data.resumeState?.userMessage != null) {
              run.identityConfirmed = true;
            }
            /**
             * Totals rebuild from the persisted backfill at sync. Replayed or
             * gap usage events already represented in the snapshot are skipped
             * via multiset matching; events that raced past the snapshot read
             * still fold so multi-call runs don't undercount.
             */
            /** Fold the run's persisted usage; events also replayed below are
             *  deduped by (runId, seq) inside the handler, so prior prompts in
             *  this conversation keep their usage and gap events still count */
            backfillUsage(data.resumeState?.collectedUsage ?? [], resumeSubmission);
            if (data.resumeState?.contextUsage) {
              /** Already reconciled to the call's real prompt tokens server-side
               *  (GenerationJobManager.persistTokenUsage) when the snapshot's call
               *  completed, so install it as-is: no client backfill reconcile. */
              contextHandler(data.resumeState.contextUsage, resumeSubmission);
            }
            /** Output streamed before this resume is not re-delivered as deltas;
             *  estimate it from the trailing aggregated content. This is
             *  needed even with a snapshot: the snapshot is pre-invoke, so the
             *  in-flight output it precedes rides on the live estimate.
             *  countTrailingOutputChars only counts output at the very end (0
             *  when paused at a tool call), so a snapshot's budget is never
             *  double-counted. */
            seedLive(
              countTrailingOutputChars(data.resumeState?.aggregatedContent),
              resumeSubmission,
            );

            const pendingOAuthPrompts = data.resumeState?.pendingOAuthPrompts ?? [];
            const pendingOAuthStepIds = new Set(pendingOAuthPrompts.map((prompt) => prompt.stepId));
            if (data.resumeState?.runSteps) {
              for (const runStep of data.resumeState.runSteps) {
                if (pendingOAuthStepIds.has(runStep.id)) {
                  continue;
                }
                stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, resumeSubmission);
              }
            }

            if (data.resumeState?.aggregatedContent && sub.userMessage?.messageId) {
              const messages = getMessages() ?? [];
              const userMsgId = sub.userMessage.messageId;
              const hasResumedContent = data.resumeState.aggregatedContent.length > 0;
              const responseId = resumeSubmission.initialResponse.messageId;
              const messageIndexes = getResumeMessageIndexes(
                messages,
                userMsgId,
                responseId,
                preliminaryUserMessageId,
                preliminaryResponseMessageId,
              );
              const responseIdx =
                messageIndexes.responseIndex >= 0
                  ? messageIndexes.responseIndex
                  : messageIndexes.preliminaryResponseIndex;

              logger.log('ResumableSSE', 'SYNC update', {
                userMsgId,
                responseId,
                responseIdx,
                foundMessageId: responseIdx >= 0 ? messages[responseIdx]?.messageId : null,
                messagesCount: messages.length,
                aggregatedContentLength: data.resumeState.aggregatedContent?.length,
              });

              if (responseIdx >= 0) {
                const oldContent = messages[responseIdx]?.content;
                /** An EMPTY resume snapshot is not authoritative over content we already loaded
                 *  for the SAME generation-owned response: assigning it would erase that content
                 *  and leave a bare cursor. Require an existing content array so it is never
                 *  swapped for `undefined`. */
                const preserveLoadedContent =
                  !hasResumedContent && Array.isArray(oldContent) && oldContent.length > 0;
                /**
                 * Replacing the response with `aggregatedContent` drops the
                 * prefix an edited resubmission had retained: the snapshot is
                 * completion-local, indexed from zero. Every later event must
                 * therefore stop offsetting, or it writes past the end of the
                 * shorter array: for an activity label that means the fill
                 * misses its own reservation and the placeholder never
                 * resolves. Preserving `oldContent` keeps the prefix, and with
                 * it the offset. Run steps and labels both read this.
                 */
                if (!preserveLoadedContent) {
                  run.editPrefixCleared = true;
                }
                const responseMessage = {
                  ...resumeSubmission.initialResponse,
                  ...messages[responseIdx],
                  messageId: responseId,
                  parentMessageId: userMsgId,
                  content: preserveLoadedContent ? oldContent : data.resumeState.aggregatedContent,
                  sender: messages[responseIdx]?.sender ?? resumeSubmission.initialResponse.sender,
                  iconURL: preferDefinedString(
                    messages[responseIdx]?.iconURL,
                    resumeSubmission.initialResponse.iconURL ?? data.resumeState.iconURL,
                  ),
                  model: preferDefinedString(
                    messages[responseIdx]?.model,
                    resumeSubmission.initialResponse.model ?? data.resumeState.model,
                  ),
                } as TMessage;
                const updated = mergeResumeMessages(
                  messages,
                  sub.userMessage,
                  responseMessage,
                  messageIndexes,
                  resumeSubmission.compact === true,
                );
                logger.log('ResumableSSE', 'SYNC updating message', {
                  messageId: responseMessage.messageId,
                  oldContentLength: Array.isArray(oldContent) ? oldContent.length : 0,
                  newContentLength: data.resumeState.aggregatedContent?.length,
                  preservedExistingContent: preserveLoadedContent,
                });
                setMessages(updated);
                resetContentHandler();
                syncStepMessage(responseMessage);
                logger.log('ResumableSSE', 'SYNC complete, handlers synced');
              } else {
                /** Same reasoning as the matched branch above: this row is
                 *  built straight from the server's completion-local
                 *  `aggregatedContent`, so it holds no retained prefix and
                 *  later steps and labels must stop offsetting. Setting it
                 *  only in the matched branch left this path adding an offset
                 *  to indices that were already absolute. */
                run.editPrefixCleared = true;
                const newMessage = {
                  ...resumeSubmission.initialResponse,
                  messageId: responseId,
                  parentMessageId: userMsgId,
                  content: data.resumeState.aggregatedContent,
                  isCreatedByUser: false,
                } as TMessage;
                setMessages(
                  mergeResumeMessages(
                    messages,
                    sub.userMessage,
                    newMessage,
                    messageIndexes,
                    resumeSubmission.compact === true,
                  ),
                );
                resetContentHandler();
                syncStepMessage(newMessage);
              }
            }

            for (const prompt of pendingOAuthPrompts) {
              applyPendingOAuthPrompt(prompt, resumeSubmission);
            }

            /**
             * Re-pause on reconnect: the run is parked on a human-review
             * interrupt. Re-apply the pending action so the approval / ask-user
             * controls render after a reload or dropped connection.
             */
            if (data.resumeState?.pendingAction) {
              applyPendingActionToMessages(data.resumeState.pendingAction as Agents.PendingAction);
            }

            /**
             * Re-seed steer chips from the server's still-queued steers.
             * Injected steers are already inside `aggregatedContent`, so this
             * covers exactly the remainder a reloading client can't know about.
             */
            // Always reconcile against the server's still-queued list: a steer
            // applied while this client was disconnected is absent here (its
            // inline part rides aggregatedContent instead), so an EMPTY list
            // must clear stale local pending chips, not leave them stranded.
            const steerConvoId = sub.submission.conversation?.conversationId ?? currentStreamId;
            seedSteerChips(
              steerConvoId,
              (data.resumeState?.pendingSteers ?? []) as TPendingSteer[],
              generationCreatedAt,
              generationProtocolVersion,
            );
            // Seed first, then remove anything already represented in the
            // authoritative content. Reversing this order can re-mint a stale
            // server snapshot entry after it was just settled.
            settleAppliedSteerParts(
              steerConvoId,
              data.resumeState?.aggregatedContent as unknown[] | undefined,
            );

            if (data.resumeState?.titleEvent) {
              titleHandler(data.resumeState.titleEvent);
            }

            /** PTC inner calls are not content parts, so the resume snapshot
             *  can't rebuild them and a settling event lost in this gap is
             *  never replayed. Mark rows still `running` as interrupted rather
             *  than leave a spinner that never resolves — and rather than drop
             *  them, since a call still executing across the reconnect settles
             *  normally on the restored stream and updates its row in place. */
            prunePtcTraces();

            const replayEvents = data.resumeState?.replayEvents ?? [];
            if (replayEvents.length > 0) {
              logger.log('ResumableSSE', `Replaying ${replayEvents.length} resume events`);
              for (const replayEvent of replayEvents) {
                const replayStepId = getStepEventId(replayEvent);
                if (
                  replayStepId != null &&
                  pendingOAuthStepIds.has(replayStepId) &&
                  isOAuthStepEvent(replayEvent)
                ) {
                  continue;
                }
                if (replayEvent.event === UsageEvents.ON_CONTEXT_USAGE) {
                  contextHandler(replayEvent.data as TContextUsageEvent, resumeSubmission);
                } else if (replayEvent.event === UsageEvents.ON_TOKEN_USAGE) {
                  usageHandler(replayEvent.data as TTokenUsageEvent, resumeSubmission);
                } else if (replayEvent.event === ApprovalEvents.ON_PENDING_ACTION) {
                  // A pause that landed after the resume snapshot must still render its
                  // controls (mirror the live handler), not fall through to stepHandler.
                  applyPendingActionToMessages(replayEvent.data as Agents.PendingAction);
                } else if (replayEvent.event === SteerEvents.ON_STEER_APPLIED) {
                  applySteerToMessages(replayEvent.data as TSteerAppliedEvent);
                } else if (replayEvent.event === SteerEvents.ON_STEER_UPDATED) {
                  updateSteerChips(replayEvent.data as TSteerUpdatedEvent);
                } else if (replayEvent.event === ActivityLabelEvents.ON_ACTIVITY_LABEL) {
                  applyActivityLabelToMessages(replayEvent.data as TActivityLabelEvent);
                } else if (replayEvent.event === ReasoningLabelEvents.ON_REASONING_LABEL) {
                  applyReasoningLabelToMessages(replayEvent.data as TReasoningLabelEvent);
                } else if (replayEvent.event === ReasoningLabelEvents.ON_REASONING_LABEL_ATTEMPT) {
                  // Durable provider-call budget reservations never render.
                } else if (replayEvent.event != null) {
                  if (
                    replayEvent.event === StepEvents.ON_MESSAGE_DELTA ||
                    replayEvent.event === StepEvents.ON_REASONING_DELTA
                  ) {
                    tapStream(replayEvent.data as Agents.MessageDeltaEvent, resumeSubmission);
                  }
                  stepHandler(replayEvent as StepEvent, resumeSubmission);
                }
              }
            }

            const pendingEvents = data.pendingEvents ?? [];
            if (pendingEvents.length > 0) {
              logger.log('ResumableSSE', `Replaying ${pendingEvents.length} pending events`);
              for (const pendingEvent of pendingEvents) {
                if (!('event' in pendingEvent)) {
                  if ('type' in pendingEvent) {
                    /** Gap output streamed past the resume snapshot must reach the
                     *  live estimate too, not just the message UI */
                    tapContent(
                      'text' in pendingEvent ? pendingEvent.text : undefined,
                      resumeSubmission,
                    );
                    contentHandler({ data: pendingEvent, submission: resumeSubmission });
                  }
                  continue;
                }
                if (pendingEvent.event === 'title') {
                  titleHandler(pendingEvent);
                } else if (pendingEvent.event === UsageEvents.ON_CONTEXT_USAGE) {
                  contextHandler(pendingEvent.data, resumeSubmission);
                } else if (pendingEvent.event === UsageEvents.ON_TOKEN_USAGE) {
                  usageHandler(pendingEvent.data, resumeSubmission);
                } else if (pendingEvent.event === ApprovalEvents.ON_PENDING_ACTION) {
                  // In-memory mode can surface a pause that landed between getResumeState()
                  // and the subscription here; route it to the same handler as a live event
                  // so the approval / ask-user controls render (else the stream sits paused
                  // with no UI until a full status reload).
                  applyPendingActionToMessages(pendingEvent.data as Agents.PendingAction);
                } else if (pendingEvent.event === SteerEvents.ON_STEER_APPLIED) {
                  applySteerToMessages(pendingEvent.data as TSteerAppliedEvent);
                } else if (pendingEvent.event === SteerEvents.ON_STEER_UPDATED) {
                  updateSteerChips(pendingEvent.data as TSteerUpdatedEvent);
                } else if (pendingEvent.event === ActivityLabelEvents.ON_ACTIVITY_LABEL) {
                  applyActivityLabelToMessages(pendingEvent.data as TActivityLabelEvent);
                } else if (pendingEvent.event === ReasoningLabelEvents.ON_REASONING_LABEL) {
                  applyReasoningLabelToMessages(pendingEvent.data as TReasoningLabelEvent);
                } else if (pendingEvent.event === ReasoningLabelEvents.ON_REASONING_LABEL_ATTEMPT) {
                  // Durable provider-call budget reservations never render.
                } else if (pendingEvent.event != null) {
                  if (
                    pendingEvent.event === StepEvents.ON_MESSAGE_DELTA ||
                    pendingEvent.event === StepEvents.ON_REASONING_DELTA
                  ) {
                    tapStream(pendingEvent.data, resumeSubmission);
                  }
                  stepHandler(pendingEvent as StepEvent, resumeSubmission);
                }
              }
            }

            setIsSubmitting(true);
            setShowStopButton(generationCreatedAt != null);
            return;
          }

          if (event.type === 'content') {
            const { data } = event;
            const { index } = data;
            const text = 'text' in data ? data.text : undefined;
            if (text != null && index !== sub.textIndex) {
              sub.textIndex = index;
            }
            tapContent(text, sub.liveSubmission());
            contentHandler({ data, submission: sub.submission as EventSubmission });
            return;
          }

          if (event.type === 'text') {
            const { data } = event;
            const text = data.text ?? data.response;
            const initialResponse = {
              ...(sub.submission.initialResponse as TMessage),
              parentMessageId: data.parentMessageId,
              messageId: data.messageId,
            } as TMessage;
            /** Legacy non-agent streams send cumulative text here; feed the
             *  live estimate like the content path above */
            const textSubmission = {
              ...sub.submission,
              userMessage: sub.userMessage,
              initialResponse,
            };
            sub.replaceSubmission(textSubmission);
            tapContent(text, textSubmission);
            messageHandler(text, textSubmission);
          }
        } catch (error) {
          logger.error('ResumableSSE', 'Error processing message:', error);
        }
      };

      /**
       * The transport emits `abort` only for this hook's own closes. A cancel
       * the user agent issued (a backgrounded or frozen mobile tab, while the
       * generation keeps running server-side) arrives as an `error` with status
       * 0 instead, so it climbs the same reconnect ladder as any dropped
       * connection rather than stranding the pane on its partial content.
       */
      const handleClose = () => {
        if (!sub.isCurrent()) {
          return;
        }

        if (run.replacementHandoff) {
          logger.log('ResumableSSE', 'Stream closed for generation handoff - preserving state');
          return;
        }
        // If we're in a reconnection cycle, don't reset state
        // (error handler will set up the reconnect timeout)
        if (run.reconnectAttempt > 0) {
          logger.log('ResumableSSE', 'Stream closed for reconnect - preserving state');
          return;
        }

        logger.log('ResumableSSE', 'Stream aborted (intentional close) - no reconnect');
        run.cancelSteerRetryFrames();
        // Clear any pending reconnect attempts
        run.clearReconnectTimeout();
        // Reset UI state - useResumeOnLoad will restore if user returns to this conversation
        setIsSubmitting(false);
        setShowStopButton(false);
        setStreamId(null);
        /** Intentional close without a final event (explicit stop, or navigation
         *  while generating): discard the in-flight pending usage so it can't
         *  merge into the next response in this conversation. On a resume the
         *  collected usage is re-folded via backfillUsage, so nothing is lost. */
        resetLive(sub.liveSubmission());
        // No final/error event fires on this path, so it's the only place left
        // to sweep a local `failed` chip; otherwise it survives this close and
        // renders (with a live Retry) under whatever run starts next. `pending`
        // chips are deliberately left alone here: this listener also fires on
        // navigation away while the run CONTINUES server-side, so a
        // server-ACK'd `pending` steer is not stranded: the server injects it
        // regardless, and sweeping it into the queue too would resend the same
        // words as a duplicate turn once `useQueueDrain` fires at run end.
        convertLocalSteersToQueued(sub.submission.conversation?.conversationId ?? currentStreamId, {
          statuses: ABORT_SWEEP_STATUSES,
        });
      };

      sub.connect(transport.stream({ token }), {
        onOpen: handleOpen,
        onFrame: (event) => void handleFrame(event),
        onFailure: (event) => void handleTransportFailure(terminal, event),
        onClose: handleClose,
      });

      // Debug hooks for testing reconnection vs clean close behavior (dev only)
      if (import.meta.env.DEV) {
        const debugWindow = window as Window & {
          __killNetwork?: () => void;
          __closeClean?: () => void;
        };

        /** Simulate network drop - triggers error event → reconnection */
        debugWindow.__killNetwork = () => {
          logger.log('Debug', 'Simulating network drop...');
          void handleTransportFailure(terminal, {});
        };

        /** Simulate clean close (navigation away) - triggers abort event → no reconnection */
        debugWindow.__closeClean = () => {
          logger.log('Debug', 'Simulating clean close (navigation away)...');
          sub.retired = true;
          sub.close();
        };
      }
    },
    [
      run,
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
      removeActiveJob,
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

  /**
   * Start generation (POST request that returns streamId)
   * Posts through the host transport, which owns auth refresh.
   * Retries transient network failures and startup readiness responses.
   * Readiness retries honor Retry-After until cleanup or the readiness window expires.
   */
  const startGeneration = useCallback(
    async (
      currentSubmission: TSubmission,
      signal?: AbortSignal,
    ): Promise<StartGenerationResult | null> => {
      const payloadData = createPayload(currentSubmission);
      let { payload } = payloadData;
      payload = removeNullishValues(payload) as TPayload;

      clearStepMaps();

      const url = payloadData.server;

      let lastError: unknown = null;
      let requestAttempts = 0;
      let networkAttempts = 0;
      let readinessAttempts = 0;
      const readinessDeadline = run.scheduler.now() + START_GENERATION_READINESS_TIMEOUT_MS;

      while (!signal?.aborted) {
        const recoverySteerId = getRecoverySteerId(currentSubmission);
        const conversationId = currentSubmission.conversation?.conversationId;
        if (
          recoverySteerId != null &&
          conversationId &&
          jotaiStore.get(recoveryDispositionsFamily(conversationId))[recoverySteerId] != null
        ) {
          restoreQueuedSubmission(currentSubmission);
          errorHandler({
            data: getStreamStartFailureData(localize('com_ui_steer_recovery_held')),
            submission: currentSubmission as EventSubmission,
          });
          setShowStopButton(false);
          setIsSubmitting(false);
          setSubmission(null);
          return null;
        }
        requestAttempts += 1;
        try {
          const data = await transport.start({ server: url, payload }, { signal });
          if (signal?.aborted) {
            return null;
          }
          if (isSettledStartResponse(data)) {
            const conversationId = getStartGenerationConversationId(data);
            if (conversationId) {
              logger.log('ResumableSSE', 'Generation already settled:', { conversationId });
              return {
                status: 'settled',
                conversationId,
                generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
              };
            }
            lastError = { response: { data } };
            break;
          }
          if (isReplacedStartResponse(data)) {
            const streamId = getStartGenerationStreamId(data);
            const conversationId = getStartGenerationConversationId(data);
            const generationCreatedAt = getStartGenerationCreatedAt(data);
            if (streamId && conversationId && generationCreatedAt != null) {
              return {
                status: 'replaced',
                streamId,
                conversationId,
                generationCreatedAt,
                generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
              };
            }
            lastError = { response: { data } };
            break;
          }
          if (isUnnegotiatedV2StartControl(data)) {
            /** Never reinterpret a v2-only control word as a legacy stream
             * response merely because it also carries a stream id. */
            lastError = { response: { data } };
            break;
          }
          const streamId = getStartGenerationStreamId(data);
          if (streamId) {
            const resumed = isResumedStartResponse(data);
            const generationCreatedAt = getStartGenerationCreatedAt(data);
            const generationProtocolVersion = getGenerationProtocolVersion(data);
            logger.log('ResumableSSE', 'Generation started:', {
              streamId,
              resumed,
              generationCreatedAt,
              generationProtocolVersion,
            });
            return {
              status: 'stream',
              streamId,
              resumed,
              generationProtocolVersion,
              ...(generationCreatedAt != null && { generationCreatedAt }),
            };
          }

          lastError = { response: { data } };
          break;
        } catch (error) {
          if (signal?.aborted) {
            return null;
          }

          const predecessorMismatch = getPredecessorMismatchStartResponse(error);
          if (predecessorMismatch != null) {
            /** Admission was atomically rejected before this queued turn
             * created anything. Put the exact row back immediately and let
             * the caller reconcile or hand off to the generation that won. */
            restoreQueuedSubmission(currentSubmission);
            logger.log('ResumableSSE', 'Queued generation lost predecessor fence', {
              expectedPredecessorCreatedAt: currentSubmission.expectedPredecessorCreatedAt,
              ...predecessorMismatch,
            });
            return {
              status: 'predecessor_mismatch',
              ...predecessorMismatch,
              generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
            };
          }

          lastError = error;
          const isNetworkError = isRetryableNetworkError(error);
          const isServerNotReady = isServerNotReadyError(error);
          const remainingReadinessMs = readinessDeadline - run.scheduler.now();
          const shouldRetryNetwork =
            isNetworkError && networkAttempts < START_GENERATION_NETWORK_RETRIES - 1;
          const shouldRetryServerNotReady = isServerNotReady && remainingReadinessMs > 0;

          if (shouldRetryNetwork || shouldRetryServerNotReady) {
            networkAttempts += isNetworkError ? 1 : 0;
            readinessAttempts += isServerNotReady ? 1 : 0;
            const fallbackDelay = Math.min(1000 * Math.pow(2, requestAttempts - 1), 8000);
            const retryDelay = isServerNotReady
              ? Math.min(getRetryAfterDelay(error, fallbackDelay), remainingReadinessMs)
              : fallbackDelay;
            const reason = isServerNotReady ? 'Server not ready' : 'Network error';
            const attempt = isServerNotReady ? readinessAttempts : networkAttempts;
            const limit = isServerNotReady
              ? `${Math.ceil(START_GENERATION_READINESS_TIMEOUT_MS / 1000)}s readiness window`
              : `${START_GENERATION_NETWORK_RETRIES}`;
            logger.log(
              'ResumableSSE',
              `${reason} starting generation, retrying in ${retryDelay}ms (attempt ${attempt}/${limit})`,
            );
            const shouldContinue = await waitForRetryDelay(retryDelay, signal);
            if (!shouldContinue) {
              return null;
            }
            continue;
          }

          // Don't retry: either not a network error or max retries reached
          break;
        }
      }

      if (signal?.aborted) {
        return null;
      }

      logger.error('ResumableSSE', 'Error starting generation:', lastError);

      const startError = toStartGenerationError(lastError);
      const errorData = startError?.response?.data;
      const responseStatus = startError?.response?.status;
      if (responseStatus != null && responseStatus >= 400 && responseStatus < 500) {
        const recoverySteerId = getRecoverySteerId(currentSubmission);
        const conversationId = currentSubmission.conversation?.conversationId;
        const recoveryRejected =
          errorData != null &&
          typeof errorData === 'object' &&
          'code' in errorData &&
          (errorData.code === 'RECOVERY_PAYLOAD_MISMATCH' ||
            errorData.code === 'INVALID_RECOVERY_REQUEST');
        if (recoveryRejected && recoverySteerId != null && conversationId) {
          jotaiStore.set(recoveryDispositionsFamily(conversationId), (previous) =>
            blockRecovery(previous, recoverySteerId),
          );
        }
        // The server rejected admission before exposing a generation. Restore
        // the exact queue row/position; ambiguous transport/5xx outcomes must
        // first reconcile durable state instead of risking a duplicate start.
        restoreQueuedSubmission(currentSubmission);
      } else {
        const recoverySteerId = getRecoverySteerId(currentSubmission);
        const recoveryConvoId = currentSubmission.conversation?.conversationId;
        if (recoverySteerId != null && recoveryConvoId) {
          try {
            const status = await fetchStreamStatus(recoveryConvoId);
            if (signal?.aborted) {
              return null;
            }
            const releasedSource = status.unrecoveredSteers?.find(
              (steer) => steer.steerId === recoverySteerId,
            );
            if (
              status.active === false &&
              supportsGenerationProtocolV2(status) &&
              releasedSource != null
            ) {
              convertSteersToQueued(recoveryConvoId, [releasedSource], {
                generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
                allowPreviouslyConvertedIds: [recoverySteerId],
              });
            }
          } catch (error) {
            if (signal?.aborted) {
              return null;
            }
            logger.warn('ResumableSSE', 'Could not recover source after start failure', {
              conversationId: recoveryConvoId,
              error,
            });
          }
        }
      }
      if (signal?.aborted) {
        return null;
      }
      const termsRefused = reopenTermsOnRefusal(queryClient, errorData);
      errorHandler({
        data: getStreamStartFailureData(
          errorData,
          termsRefused ? localize('com_error_terms_not_accepted') : undefined,
        ),
        submission: currentSubmission as EventSubmission,
      });
      setShowStopButton(false);
      setIsSubmitting(false);
      setSubmission(null);
      return null;
    },
    [
      run,
      clearStepMaps,
      convertSteersToQueued,
      errorHandler,
      jotaiStore,
      localize,
      queryClient,
      restoreQueuedSubmission,
      setIsSubmitting,
      setShowStopButton,
      setSubmission,
      transport,
    ],
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
        const startResult = await startGeneration(submission, signal);
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

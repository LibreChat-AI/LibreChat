import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useStore, useSetAtom, useAtomValue } from 'jotai';
import {
  Constants,
  isAssistantsEndpoint,
  isForcedTemporaryRetention,
} from 'librechat-data-provider';
import {
  activeGenerationCreatedAtByConvoId,
  useIsSubmitting,
  submissionStartFamily,
  submissionByIndex,
  useSubmission,
} from '@librechat/chat/react';
import {
  hasSubmissionUserMessage,
  getGenerationProtocolVersion,
  supportsGenerationProtocolV2,
  buildMinimalResumeSubmission,
  resumeStateMatchesSubmission,
  getResumeBranchTargetMessageId,
  buildSubmissionFromResumeState,
} from '@librechat/chat';
import type { TMessage, Agents } from 'librechat-data-provider';
import { siblingIdxFamily, siblingKey } from '~/components/Chat/Messages/Thread/state';
import { pendingApprovalActionFamily } from '~/components/Chat/approval/state';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import { getBranchSiblingIndexesForTarget } from '~/utils';
import useResumeAnnouncements from './announcements';
import { useStreamStatus } from '~/data-provider';
import { settleFinishedRun } from './finished';
import useOwedSuccessor from './successor';
import useSteerState from './steer';

/**
 * Hook to resume streaming if navigating to a conversation with active generation.
 * Checks stream status via React Query and sets submission if active job found.
 *
 * This hook:
 * 1. Uses useStreamStatus to check for active jobs on navigation
 * 2. If active job found, builds a submission with streamId and sets it
 * 3. useResumableSSE picks up the submission and subscribes to the stream
 *
 * @param messagesLoaded - Whether the messages query has finished loading (prevents race condition)
 */
export default function useResumeOnLoad(
  conversationId: string | undefined,
  getMessages: () => TMessage[] | undefined,
  runIndex = 0,
  messagesLoaded = true,
) {
  const jotaiStore = useStore();
  const queryClient = useQueryClient();
  const setSubmission = useSetAtom(submissionByIndex(runIndex));
  const setSubmissionStart = useSetAtom(submissionStartFamily(runIndex));
  const currentSubmission = useSubmission(runIndex);
  const isSubmitting = useIsSubmitting(runIndex);
  const attachedGenerationCreatedAt = useAtomValue(
    activeGenerationCreatedAtByConvoId(conversationId ?? ''),
  );
  const { config, usePaneConversation } = useChatSettings();
  const currentConversation = usePaneConversation(runIndex);
  const endpoint = currentConversation?.endpoint;
  const endpointType = currentConversation?.endpointType;
  const actualEndpoint = endpointType ?? endpoint;
  const resumableEnabled = !isAssistantsEndpoint(actualEndpoint);
  const startupConfigSettled = config.loaded !== false;
  const isRetentionForced = isForcedTemporaryRetention(config.retentionMode);
  // Track conversations we've already processed (either resumed or skipped)
  const processedConvoRef = useRef<string | null>(null);
  /**
   * When this pane last answered an active-job announcement, per conversation.
   * A job stays listed for its whole lifetime, so the announcement cannot be
   * consumed once and latched: two external runs back to back leave the list
   * reading `[conversationId]` continuously, and a latch keyed on observing it
   * empty would never release. Rate-limit to the list's own heartbeat instead —
   * repeatable, and still one status read per interval at worst.
   */
  const answeredActiveJobRef = useRef<{ conversationId: string; at: number } | null>(null);
  /**
   * Bumped when an announcement is answered. Clearing `processedConvoRef` alone
   * cannot restart the check below: a ref mutation neither schedules a render
   * nor re-runs an effect, so the arm has to be a value the effect depends on.
   */
  const [externalRunArm, setExternalRunArm] = useState(0);
  /** `generationHandoff` lives in the React Query snapshot until a later
   * status refetch. Remember the exact epoch already consumed so clearing the
   * replacement submission on FINAL cannot re-install that stale snapshot and
   * enter a resume→404→resume loop. A genuinely newer handoff has a different
   * createdAt key and remains eligible. */
  const consumedHandoffGenerationRef = useRef<string | null>(null);
  const restoreResumeBranch = useCallback(
    (resumeState: Agents.ResumeState, messages: TMessage[], activeConversationId: string) => {
      const targetMessageId = getResumeBranchTargetMessageId(resumeState, messages);
      const branchIndexes = getBranchSiblingIndexesForTarget(
        messages,
        targetMessageId,
        activeConversationId,
      );

      for (const { parentMessageId, siblingIdx } of branchIndexes) {
        jotaiStore.set(siblingIdxFamily(siblingKey(parentMessageId)), siblingIdx);
      }
    },
    [jotaiStore],
  );

  /** Pending-steer chips for steers the server still has queued (injected ones
   *  already live inside the resumed aggregatedContent). */
  const steerState = useSteerState();
  const { seedSteerChips, settleAppliedSteerParts, updateActiveGenerationCreatedAt } = steerState;

  // Check for active stream when conversation changes
  const submissionConvoId = currentSubmission?.conversation?.conversationId;
  const loadedMessages = messagesLoaded ? getMessages() : undefined;
  const hasExplicitSubmissionMatch = !!conversationId && submissionConvoId === conversationId;
  const hasHydratedMessageMatch =
    submissionConvoId == null &&
    hasSubmissionUserMessage(currentSubmission, loadedMessages, conversationId);
  const hasActiveSubmissionForThisConvo =
    !!currentSubmission && (hasExplicitSubmissionMatch || hasHydratedMessageMatch);
  const hasStaleSubmissionForDifferentConvo =
    !!currentSubmission && submissionConvoId != null && submissionConvoId !== conversationId;
  /**
   * A submission only stands in for an attachment while one is actually live.
   * The FINAL path never clears the atom, so a pane that just finished a run
   * keeps holding the submission it completed — bookkeeping, not a stream.
   *
   * Two signals, because neither covers the whole lifetime on its own.
   * `isSubmitting` is raised by `ask` before a submission is installed and held
   * across reconnect backoff, so sends and recovery both read as attached. It
   * is not raised for a resumed attachment until that stream opens, though, and
   * this effect installs the submission well before then — so an announcement
   * landing in that window would tear down the attachment it had just built.
   * The generation epoch closes it: this hook stamps it immediately before
   * installing a resume submission, `subscribeToStream` stamps it for every
   * other attachment, and terminal teardown is what clears it.
   */
  const hasLiveSubmissionForThisConvo =
    hasActiveSubmissionForThisConvo && (isSubmitting || attachedGenerationCreatedAt != null);

  const owed = useOwedSuccessor({
    conversationId,
    resumableEnabled,
    attachedGenerationCreatedAt,
    hasLiveSubmissionForThisConvo,
  });
  const { queuedTurnReceipts } = owed;

  const shouldCheck =
    resumableEnabled &&
    messagesLoaded && // Wait for messages to load before checking
    startupConfigSettled && // The forced retention mode decides the rebuilt submission's temporary state
    !hasActiveSubmissionForThisConvo && // Allow if no submission or a confirmed stale submission
    !!conversationId &&
    conversationId !== Constants.NEW_CONVO &&
    processedConvoRef.current !== conversationId; // Don't re-check processed convos

  const {
    data: streamStatus,
    dataUpdatedAt: streamStatusUpdatedAt,
    isSuccess,
    isFetching,
  } = useStreamStatus(conversationId, shouldCheck);

  useEffect(() => {
    console.log('[ResumeOnLoad] Effect check', {
      resumableEnabled,
      conversationId,
      messagesLoaded,
      hasCurrentSubmission: !!currentSubmission,
      currentSubmissionConvoId: currentSubmission?.conversation?.conversationId,
      isSuccess,
      isFetching,
      streamStatusActive: streamStatus?.active,
      streamStatusStreamId: streamStatus?.streamId,
      processedConvoRef: processedConvoRef.current,
    });

    if (!resumableEnabled || !conversationId || conversationId === Constants.NEW_CONVO) {
      console.log('[ResumeOnLoad] Skipping - not enabled or new convo');
      return;
    }

    // Wait for messages to load to avoid race condition where sync overwrites then DB overwrites
    if (!messagesLoaded) {
      console.log('[ResumeOnLoad] Waiting for messages to load');
      return;
    }

    if (!startupConfigSettled) {
      return;
    }

    // Don't resume if we already have an active submission FOR THIS CONVERSATION
    // A stale submission with undefined/different conversationId should not block us
    if (hasActiveSubmissionForThisConvo) {
      console.log('[ResumeOnLoad] Skipping - already have active submission for this conversation');
      // Mark as processed so we don't try again
      processedConvoRef.current = conversationId;
      return;
    }

    // If there's a stale submission for a different conversation, log it but continue
    if (hasStaleSubmissionForDifferentConvo) {
      console.log(
        '[ResumeOnLoad] Found stale submission for different conversation, will check for resume',
        {
          staleConvoId: submissionConvoId,
          currentConvoId: conversationId,
        },
      );
    }

    // Wait for stream status query to complete (including background refetches
    // that may replace a stale cached result with fresh data)
    if (!isSuccess || !streamStatus || isFetching) {
      console.log('[ResumeOnLoad] Waiting for stream status query');
      return;
    }

    const statusPendingAction =
      streamStatus.pendingAction ?? streamStatus.resumeState?.pendingAction;
    if (statusPendingAction != null) {
      jotaiStore.set(pendingApprovalActionFamily(conversationId), statusPendingAction);
    } else if (!streamStatus.active) {
      jotaiStore.set(pendingApprovalActionFamily(conversationId), null);
    }

    /** useResumableSSE detected that this conversation-scoped stream now
     * belongs to a newer generation. It cleared the stale submission and
     * cached the replacement snapshot; allow the same conversation to be
     * processed again so this epoch becomes the active resume submission. */
    const generationProtocolVersion = getGenerationProtocolVersion(streamStatus);
    const isGenerationProtocolV2 = supportsGenerationProtocolV2(streamStatus);
    const handoffGenerationKey =
      isGenerationProtocolV2 &&
      streamStatus.generationHandoff === true &&
      streamStatus.createdAt != null
        ? `${conversationId}:${streamStatus.createdAt}`
        : null;
    if (
      currentSubmission == null &&
      handoffGenerationKey != null &&
      consumedHandoffGenerationRef.current !== handoffGenerationKey &&
      streamStatus.active &&
      processedConvoRef.current === conversationId
    ) {
      processedConvoRef.current = null;
    }

    if (
      streamStatus.active &&
      streamStatus.streamId &&
      submissionConvoId == null &&
      resumeStateMatchesSubmission(streamStatus, currentSubmission)
    ) {
      console.log('[ResumeOnLoad] Skipping - active submission matches stream status', {
        streamId: streamStatus.streamId,
        currentConvoId: conversationId,
        userMessageId: currentSubmission?.userMessage?.messageId,
      });
      processedConvoRef.current = conversationId;
      return;
    }

    // Don't process the same conversation twice
    if (processedConvoRef.current === conversationId) {
      console.log('[ResumeOnLoad] Skipping - already processed this conversation');
      return;
    }

    if (!streamStatus.active || !streamStatus.streamId) {
      console.log('[ResumeOnLoad] No active job to resume for:', conversationId);
      settleFinishedRun({
        jotaiStore,
        queryClient,
        steers: steerState,
        conversationId,
        streamStatus,
        streamStatusUpdatedAt,
        queuedTurnReceipts,
        getMessages,
        generationProtocolVersion,
      });
      processedConvoRef.current = conversationId;
      return;
    }

    /** Still generating: a marker left for this run stays until the resume's stream delivers its
     *  end or its recovery reads it from history, and the resume's start retires a marker left
     *  for any other run, so the job deleted between this read and the attach is not lost. */
    processedConvoRef.current = conversationId;
    if (handoffGenerationKey != null) {
      consumedHandoffGenerationRef.current = handoffGenerationKey;
    }
    if (streamStatus.createdAt != null) {
      updateActiveGenerationCreatedAt(
        conversationId,
        streamStatus.createdAt,
        undefined,
        generationProtocolVersion,
      );
    }

    console.log('[ResumeOnLoad] Found active job, creating submission...', {
      streamId: streamStatus.streamId,
      status: streamStatus.status,
      resumeState: streamStatus.resumeState,
    });

    const messages = getMessages() || [];
    /** Fill the elapsed baseline only when none survives: a reattach to the run
     *  this session already anchored keeps its original start (the atom outlives
     *  the submission). A run it never anchored — after a reload, or started by
     *  another client — rebuilds the real baseline from the server-computed
     *  generation age, which keeps both clocks comparing only to themselves.
     *  The age is subtracted from the moment the status RESPONSE arrived
     *  (`dataUpdatedAt`), not from now: this effect trails the response behind
     *  `messagesLoaded`, and a slow history fetch would silently shrink the
     *  reading. Raw `createdAt` (an older server) still beats counting from
     *  attach; the indicator clamps whatever skew that carries. */
    setSubmissionStart((prev) => {
      if (prev != null) {
        return prev;
      }
      if (streamStatus.elapsedMs != null) {
        return (streamStatusUpdatedAt || Date.now()) - streamStatus.elapsedMs;
      }
      return streamStatus.createdAt ?? Date.now();
    });

    // Build submission from resume state if available
    if (streamStatus.resumeState) {
      restoreResumeBranch(streamStatus.resumeState, messages, conversationId);
      seedSteerChips(
        conversationId,
        streamStatus.resumeState.pendingSteers ?? [],
        streamStatus.createdAt,
        generationProtocolVersion,
      );
      // Restore the server's pending snapshot before settling inline steer
      // parts. A steer present in both views was applied during the snapshot
      // boundary and must finish absent, never resurrected as a chip.
      settleAppliedSteerParts(conversationId, [
        ...messages,
        ...(streamStatus.resumeState.aggregatedContent ?? []),
      ]);
      const submission = buildSubmissionFromResumeState(
        streamStatus.resumeState,
        streamStatus.streamId,
        messages,
        conversationId,
        streamStatus.createdAt,
        generationProtocolVersion,
        streamStatus.isTemporary === true || isRetentionForced,
      );
      setSubmission(submission);
    } else {
      setSubmission(
        buildMinimalResumeSubmission({
          messages,
          conversationId,
          streamId: streamStatus.streamId,
          createdAt: streamStatus.createdAt,
          aggregatedContent: streamStatus.aggregatedContent,
          isTemporary: streamStatus.isTemporary === true || isRetentionForced,
          generationProtocolVersion,
        }),
      );
    }
  }, [
    conversationId,
    resumableEnabled,
    messagesLoaded,
    hasActiveSubmissionForThisConvo,
    submissionConvoId,
    hasStaleSubmissionForDifferentConvo,
    currentSubmission,
    isSuccess,
    isFetching,
    streamStatus,
    streamStatusUpdatedAt,
    queuedTurnReceipts,
    queryClient,
    getMessages,
    setSubmission,
    setSubmissionStart,
    restoreResumeBranch,
    steerState,
    seedSteerChips,
    settleAppliedSteerParts,
    updateActiveGenerationCreatedAt,
    jotaiStore,
    externalRunArm,
    isRetentionForced,
    startupConfigSettled,
  ]);

  // Reset processedConvoRef when conversation changes to allow re-checking
  useEffect(() => {
    // Always reset when conversation changes - this allows resuming when navigating back
    if (conversationId !== processedConvoRef.current) {
      console.log('[ResumeOnLoad] Resetting processedConvoRef for new conversation:', {
        old: processedConvoRef.current,
        new: conversationId,
      });
      processedConvoRef.current = null;
      consumedHandoffGenerationRef.current = null;
      answeredActiveJobRef.current = null;
    }
  }, [conversationId]);

  /** The route can name a conversation before this pane has loaded it; until then the endpoint
   *  that decides resumability is the previous conversation's, so the request waits. */
  useResumeAnnouncements({
    conversationId,
    resumableEnabled,
    owed,
    processedConvoRef,
    answeredActiveJobRef,
    setExternalRunArm,
    setSubmission,
    routeConversationLoaded: currentConversation?.conversationId === conversationId,
    hasActiveSubmissionForThisConvo,
    hasLiveSubmissionForThisConvo,
    attachedGenerationCreatedAt,
  });
}

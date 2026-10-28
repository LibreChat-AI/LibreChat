import { Constants } from 'librechat-data-provider';
import type { TPendingSteer } from 'librechat-data-provider';
import type { StreamStatusResponse, MountContext } from './host';
import type { StartGenerationResult } from './start';
import { GENERATION_PROTOCOL_VERSION, supportsGenerationProtocolV2 } from '../protocol';
import { isInitialNewConversation, keepLocalCodeApprovalMode } from './messages';

export type ReplacedStart = Extract<StartGenerationResult, { status: 'replaced' }>;
type MismatchStart = Extract<StartGenerationResult, { status: 'predecessor_mismatch' }>;

/**
 * A queued turn lost its predecessor fence. Decides from a fresh status read (or the atomic
 * 409 itself) whether a different live epoch owns the conversation, restoring the queued turn
 * either way. Resolves to the replacement to hand off to, or null once it reconciled history
 * without one (or the pane moved on).
 */
export async function resolvePredecessorMismatch(
  mount: MountContext,
  startResult: MismatchStart,
): Promise<{
  replacementStart: ReplacedStart | null;
  knownReplacementStatus: StreamStatusResponse | null;
} | null> {
  const { run, host, submission, isCurrent } = mount;
  let replacementStart: ReplacedStart | null = null;
  let knownReplacementStatus: StreamStatusResponse | null = null;
  const expectedPredecessorCreatedAt = submission.expectedPredecessorCreatedAt;
  let refreshedStatus: StreamStatusResponse | null = null;
  try {
    refreshedStatus = await host.fetchStatus(startResult.conversationId);
    if (!isCurrent()) {
      return null;
    }
  } catch (error) {
    if (!isCurrent()) {
      return null;
    }
    host.logger.warn('ResumableSSE', 'Could not refresh predecessor mismatch status', {
      conversationId: startResult.conversationId,
      error,
    });
  }
  if (!isCurrent()) {
    return null;
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
    host.steers.restoreQueued(submission, refreshedStatus.createdAt);
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
    host.steers.restoreQueued(submission, startResult.generationCreatedAt!);
  } else {
    /** No different live epoch is proven. Reconcile away the
     * optimistic C rows, but publish no run-end: doing so would
     * immediately drain and re-send the just-restored queue item. */
    const terminalWinnerCreatedAt = refreshedStatus?.createdAt ?? startResult.generationCreatedAt;
    if (terminalWinnerCreatedAt != null) {
      host.steers.restoreQueued(submission, terminalWinnerCreatedAt);
    }
    if (refreshedStatus != null) {
      host.cache.setStreamStatus(startResult.conversationId, refreshedStatus);
    } else {
      host.cache.invalidateStreamStatus(startResult.conversationId);
    }
    try {
      await host.cache.invalidateMessages(startResult.conversationId, 'all');
      if (!isCurrent()) {
        return null;
      }
      await host.cache.refreshConversation(startResult.conversationId);
      if (!isCurrent()) {
        return null;
      }
      await host.cache.refreshConversationLists();
      if (!isCurrent()) {
        return null;
      }
      await host.cache.refreshPinnedConversations();
      if (!isCurrent()) {
        return null;
      }
    } catch (error) {
      if (!isCurrent()) {
        return null;
      }
      host.logger.warn('ResumableSSE', 'Could not reconcile predecessor mismatch history', {
        conversationId: startResult.conversationId,
        error,
      });
    }
    host.pane.clearDrainAfterAbort(startResult.conversationId, expectedPredecessorCreatedAt);
    run.submission = null;
    host.pane.setIsSubmitting(false);
    host.pane.setShowStopButton(false);
    host.pane.setSubmission(null);
    return null;
  }
  return { replacementStart, knownReplacementStatus };
}

/**
 * This POST belongs to an older optimistic submission, while the conversation-scoped stream
 * now belongs to a newer generation. Hands the pane to that generation without ever attaching
 * the older submission to it.
 */
export async function handoffStartToReplacement(
  mount: MountContext,
  replacementStart: ReplacedStart,
  knownReplacementStatus: StreamStatusResponse | null,
): Promise<void> {
  const { run, host, submission, isCurrent } = mount;
  /** This POST belongs to an older optimistic submission, while the
   * conversation-scoped stream id now belongs to a newer generation.
   * Never attach A's submission directly to B. Discover B's
   * authoritative resume snapshot, refresh durable history, then let
   * useResumeOnLoad construct a new epoch-fenced submission. */
  const replacementStatus =
    knownReplacementStatus ??
    (await host.fetchStatus(replacementStart.conversationId).catch((error) => {
      if (!isCurrent()) {
        return null;
      }
      host.logger.warn('ResumableSSE', 'Could not discover replacement start generation', {
        conversationId: replacementStart.conversationId,
        generationCreatedAt: replacementStart.generationCreatedAt,
        error,
      });
      return null;
    }));
  if (!isCurrent()) {
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
      await host.cache.invalidateMessages(replacementStart.conversationId, 'all');
      if (!isCurrent()) {
        return;
      }
      await host.cache.refreshConversation(replacementStart.conversationId);
      if (!isCurrent()) {
        return;
      }
      await host.cache.refreshConversationLists();
      if (!isCurrent()) {
        return;
      }
      await host.cache.refreshPinnedConversations();
      if (!isCurrent()) {
        return;
      }
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      host.logger.warn('ResumableSSE', 'Could not refresh replacement generation history', {
        conversationId: replacementStart.conversationId,
        error,
      });
    }
    const authoritativeConversation = host.cache.getConversation(replacementStart.conversationId);
    if (authoritativeConversation?.conversationId === replacementStart.conversationId) {
      const localConversationId = isInitialNewConversation(submission)
        ? Constants.NEW_CONVO
        : replacementStart.conversationId;
      host.pane.setConversation?.((current) =>
        keepLocalCodeApprovalMode(authoritativeConversation, current, localConversationId),
      );
    }
    host.cache.setStreamStatus(replacementStart.conversationId, {
      ...replacementStatus,
      generationHandoff: true,
    });
    host.pane.setGenerationEpoch(
      replacementStart.conversationId,
      replacementStart.generationCreatedAt,
      undefined,
      replacementStart.generationProtocolVersion,
    );
    host.cache.addActiveJob(replacementStart.streamId);
    if (startedAsNewConvo) {
      run.optimisticStreamIds.add(replacementStart.streamId);
      host.pane.setGenerationEpoch(
        Constants.NEW_CONVO,
        replacementStart.generationCreatedAt,
        undefined,
        replacementStart.generationProtocolVersion,
      );
      host.pane.replaceNewConversationUrl(replacementStart.conversationId);
    }
    host.steers.seed(
      replacementStart.conversationId,
      (replacementStatus.resumeState?.pendingSteers ?? []) as TPendingSteer[],
      replacementStart.generationCreatedAt,
      replacementStart.generationProtocolVersion,
    );
    host.steers.settleApplied(
      replacementStart.conversationId,
      replacementStatus.resumeState?.aggregatedContent ?? replacementStatus.aggregatedContent,
    );
    run.replacementHandoff = true;
    run.submission = null;
    host.pane.setIsSubmitting(true);
    host.pane.setShowStopButton(true);
    host.pane.setSubmission(null);
    return;
  }

  /** The server reported a replacement but its authoritative status
   * could not be confirmed. Drop A without ever attaching it to B;
   * leave history/status invalidated so navigation/reload can recover,
   * and keep any queued text parked (non-completed outcome). */
  host.cache.invalidateStreamStatus(replacementStart.conversationId);
  host.cache.invalidateMessages(replacementStart.conversationId, 'active');
  host.pane.clearDrainAfterAbort(
    replacementStart.conversationId,
    replacementStart.generationCreatedAt,
  );
  host.pane.setIsSubmitting(false);
  host.pane.setShowStopButton(false);
  host.pane.publishRunEnd({
    conversationId: replacementStart.conversationId,
    outcome: 'error',
    endedAt: run.scheduler.now(),
    generationCreatedAt: replacementStart.generationCreatedAt,
  });
  host.pane.setSubmission(null);
}

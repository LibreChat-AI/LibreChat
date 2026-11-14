import { Constants } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { TerminalContext } from './terminal';
import {
  restoreLiveStatus,
  handoffToReplacement,
  clearPendingApprovalForTerminal,
  clearAttachedGenerationCreatedAt,
} from './terminal';
import { GENERATION_PROTOCOL_VERSION, supportsGenerationProtocolV2 } from '../protocol';
import { isInitialNewConversation, keepLocalCodeApprovalMode } from './messages';
import { getRecoverySteerId, toStartGenerationError } from './start';

/**
 * A 404 from the stream route: the job completed and was cleaned up, and its messages are
 * persisted. Refetches and reconciles them before recovering local steers (the final response
 * may contain an applied steer whose live event was missed), unless a status read shows the
 * generation, or a newer one, still running.
 */
export async function recoverMissingStream(ctx: TerminalContext): Promise<void> {
  const { sub, host } = ctx;
  const { run, generationCreatedAt, generationProtocolVersion } = sub;
  const currentStreamId = sub.streamId;
  const convoId = sub.submission.conversation?.conversationId;
  host.logger.log('ResumableSSE', 'Stream 404, invalidating messages for:', convoId);
  // Keep the UI non-idle while the status read decides whether this is
  // terminal cleanup or a handoff to a newer generation epoch.
  run.reconnectAttempt = Math.max(run.reconnectAttempt, 1);
  run.cancelSteerRetryFrames();
  sub.close();
  /** Terminal: drop any in-flight live estimate so the gauge doesn't
   *  keep counting stale streamed output after the stream ends */
  host.events.resetLive(sub.liveSubmission());
  host.pane.clearComposerDrafts(convoId, {
    includeNewChatDraft:
      !convoId ||
      convoId === Constants.NEW_CONVO ||
      run.optimisticStreamIds.has(currentStreamId) ||
      isInitialNewConversation(sub.submission),
  });
  host.events.clearStepMaps();
  let persistedMessages: TMessage[] | undefined;
  if (convoId) {
    try {
      await host.cache.invalidateMessages(convoId, 'none');
      if (!sub.isCurrent()) {
        return;
      }
      // The first stream can finish before CREATED mounts the saved-chat query.
      const fetched = await host.cache.fetchMessages(convoId, true);
      if (!sub.isCurrent()) {
        return;
      }
      if (Array.isArray(fetched)) {
        persistedMessages = fetched;
      }
    } catch (error) {
      if (!sub.isCurrent()) {
        return;
      }
      host.logger.warn('ResumableSSE', 'Could not reconcile persisted messages after 404', {
        conversationId: convoId,
        error,
      });
    }
    host.cache.removeStreamStatus(convoId);
  }
  const recoveryConvoId = convoId ?? currentStreamId;
  const reconciledIds = new Set(persistedMessages ? host.steers.appliedIds(persistedMessages) : []);
  if (persistedMessages) {
    host.steers.settleApplied(recoveryConvoId, persistedMessages);
  }

  // The status replay is owner-gated and non-destructive; creating a
  // recovered follow-up consumes its exact source. Prefer these
  // authoritative leftovers over guessing from local chips.
  let confirmedV2Terminal = false;
  try {
    const status = await host.fetchStatus(recoveryConvoId);
    if (!sub.isCurrent()) {
      return;
    }
    if (
      generationProtocolVersion === GENERATION_PROTOCOL_VERSION &&
      !supportsGenerationProtocolV2(status)
    ) {
      sub.scheduleReattach(1_000);
      return;
    }
    if (
      status.active === true &&
      status.createdAt != null &&
      (generationCreatedAt == null || status.createdAt !== generationCreatedAt)
    ) {
      const handedOff = await handoffToReplacement(ctx, recoveryConvoId, status);
      if (!sub.isCurrent()) {
        return;
      }
      if (handedOff) {
        return;
      }
      /** Legacy generations have no replacement-handoff contract.
       * Never attach this submission to a different epoch. */
      sub.scheduleReattach(1_000);
      return;
    }
    if (status.active === true) {
      /** A stream lookup can briefly lose its routing record while the
       * authoritative job status still proves the same generation is
       * alive. Preserve ownership and retry the attachment instead of
       * publishing a terminal run-end (which could auto-drain queued
       * text into a still-running generation). */
      const activeStreamId = status.streamId ?? currentStreamId;
      host.cache.setStreamStatus(recoveryConvoId, status);
      if (status.createdAt != null) {
        host.pane.setGenerationEpoch(
          recoveryConvoId,
          status.createdAt,
          undefined,
          generationProtocolVersion,
        );
      }
      host.cache.addActiveJob(activeStreamId);
      restoreLiveStatus(ctx, recoveryConvoId, status, status.createdAt, generationProtocolVersion);
      host.pane.setIsSubmitting(true);
      host.pane.setShowStopButton(status.createdAt != null);
      run.reconnectAttempt = Math.max(run.reconnectAttempt, 1);
      sub.scheduleReattach(1_000, activeStreamId, status.createdAt);
      return;
    }
    confirmedV2Terminal =
      generationProtocolVersion === GENERATION_PROTOCOL_VERSION &&
      supportsGenerationProtocolV2(status);
    const canRecoverTerminalSteers = generationProtocolVersion === 1 || confirmedV2Terminal;
    const unrecovered = canRecoverTerminalSteers ? (status.unrecoveredSteers ?? []) : [];
    if (unrecovered.length > 0) {
      const recoverySteerId = getRecoverySteerId(sub.submission);
      host.steers.convertToQueued(recoveryConvoId, unrecovered, {
        generationProtocolVersion,
        ...(recoverySteerId != null && {
          allowPreviouslyConvertedIds: [recoverySteerId],
        }),
      });
      for (const steer of unrecovered) {
        reconciledIds.add(steer.steerId);
        if (steer.clientSteerId) {
          reconciledIds.add(steer.clientSteerId);
        }
      }
    }
  } catch (error) {
    if (!sub.isCurrent()) {
      return;
    }
    host.logger.warn('ResumableSSE', 'Could not recover parked steers after 404', {
      conversationId: recoveryConvoId,
      error,
    });
  }

  host.cache.removeActiveJob(currentStreamId);
  clearAttachedGenerationCreatedAt(ctx);
  clearPendingApprovalForTerminal(ctx, recoveryConvoId);
  if (!run.createdStreamIds.has(currentStreamId) && run.optimisticStreamIds.has(currentStreamId)) {
    // Both fresh and resumed subscriptions can miss every event of a fast turn.
    // A missing job proves neither that the conversation was saved nor that it failed.
    try {
      const persisted = await host.cache.fetchConversation(recoveryConvoId);
      if (!sub.isCurrent()) return;
      if (persisted?.conversationId === recoveryConvoId) {
        host.cache.setConversation(recoveryConvoId, persisted);
        host.cache.upsertConversation(persisted);
        host.pane.updateConversation?.((current) => {
          if (
            current?.conversationId != null &&
            current.conversationId !== Constants.NEW_CONVO &&
            current.conversationId !== recoveryConvoId
          )
            return current;
          return keepLocalCodeApprovalMode(
            { ...current, ...persisted },
            current,
            current?.conversationId,
          );
        });
      }
    } catch (error) {
      if (!sub.isCurrent()) return;
      if (toStartGenerationError(error)?.response?.status === 404) {
        host.cache.removeConversation(currentStreamId);
      }
    }
    // An inconclusive read must not turn a saved chat into a phantom.
    void host.cache.refreshConversationLists();
    void host.cache.refreshPinnedConversations();
  }
  if (persistedMessages) {
    host.messages.set(persistedMessages);
  }
  sub.retired = true;
  host.pane.setIsSubmitting(false);
  host.pane.setShowStopButton(false);

  // Only infer recovery from local accepted chips after the persisted
  // final was successfully inspected. If that fetch failed, their
  // applied-vs-leftover outcome is unknown and converting could send
  // already-applied words twice.
  if (persistedMessages && (generationProtocolVersion === 1 || confirmedV2Terminal)) {
    host.steers.convertLocalToQueued(recoveryConvoId, {
      excludeSteerIds: reconciledIds,
      generationProtocolVersion,
    });
  }
  // The true outcome is unknown here (job record already cleaned up):
  // a non-'completed' outcome releases parked interrupt flags without
  // auto-sending queued messages the user may not want fired. A run this
  // pane left and came back to is the exception: the history just read
  // names its response by epoch, which is the outcome it would have had.
  // History read before the job finished may not hold that response yet, or
  // may hold only the unfinished snapshot saved when the pane left, so a
  // marker that read leaves unresolved or stopped outlives this end for the
  // next visit, which reads history after the job is known to be done.
  const detached = host.pane.resolveDetachedEnd(recoveryConvoId, persistedMessages);
  const detachedResolvable = detached.resolvable;
  const detachedEnd = detached.end;
  host.pane.publishRunEnd(
    {
      conversationId: recoveryConvoId,
      outcome: 'aborted',
      endedAt: run.scheduler.now(),
      ...detachedEnd,
      startedAsNewConvo: run.optimisticStreamIds.has(currentStreamId),
    },
    {
      retainDetached:
        detachedResolvable && (detachedEnd == null || detachedEnd.outcome === 'aborted'),
    },
  );
  host.pane.setStreamId(null);
  run.releaseStream(currentStreamId);
  run.reconnectAttempt = 0;
}

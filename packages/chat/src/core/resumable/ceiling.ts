import type { TMessage } from 'librechat-data-provider';
import type { StreamStatusResponse } from './host';
import type { TerminalContext } from './terminal';
import {
  restoreLiveStatus,
  handoffToReplacement,
  clearPendingApprovalForTerminal,
  clearAttachedGenerationCreatedAt,
} from './terminal';
import { GENERATION_PROTOCOL_VERSION, supportsGenerationProtocolV2 } from '../protocol';
import { completedResponseMessageId } from './messages';
import { getRecoverySteerId } from './start';

/**
 * The connection failed past the last retry. The transport gave up, not necessarily the
 * generation: a status read decides whether to keep waiting on it (or hand it to a newer
 * epoch), and only a status that proves it terminal settles the run from durable history.
 */
export async function settleAfterRetryCeiling(ctx: TerminalContext): Promise<void> {
  const { sub, host } = ctx;
  const { run, generationCreatedAt, generationProtocolVersion } = sub;
  const currentStreamId = sub.streamId;
  host.logger.error('ResumableSSE', 'Max reconnect attempts reached');
  sub.close();
  host.events.flushPendingDeltas();
  const recoveryConvoId = sub.submission.conversation?.conversationId ?? currentStreamId;
  let status: StreamStatusResponse | undefined;
  try {
    status = await host.fetchStatus(recoveryConvoId);
    if (!sub.isCurrent()) {
      return;
    }
  } catch (error) {
    if (!sub.isCurrent()) {
      return;
    }
    host.logger.warn('ResumableSSE', 'Could not determine job state after reconnect limit', {
      conversationId: recoveryConvoId,
      error,
    });
  }

  if (
    status != null &&
    generationProtocolVersion === GENERATION_PROTOCOL_VERSION &&
    !supportsGenerationProtocolV2(status)
  ) {
    // A legacy responder cannot adjudicate a v2 job during rollout.
    status = undefined;
  }

  if (
    status?.active === true &&
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
    run.reconnectAttempt = 0;
    sub.scheduleReattach(30_000);
    return;
  }

  if (status?.active === true) {
    // The transport gave up, not the generation. Keep the active-job
    // marker and accepted chips intact, then release this stale
    // submission so useResumeOnLoad can establish a fresh attachment.
    host.cache.setStreamStatus(recoveryConvoId, status);
    restoreLiveStatus(ctx, recoveryConvoId, status, status.createdAt, generationProtocolVersion);
    host.pane.setIsSubmitting(true);
    host.pane.setShowStopButton(generationCreatedAt != null);
    run.reconnectAttempt = 0;
    sub.scheduleReattach(30_000);
    return;
  }

  if (status == null) {
    // An inconclusive status read is still not proof of termination.
    // Preserve server/client ownership and let the normal resume-on-load
    // status query retry rather than duplicating accepted words.
    host.cache.invalidateStreamStatus(recoveryConvoId);
    host.pane.setIsSubmitting(true);
    host.pane.setShowStopButton(generationCreatedAt != null);
    run.reconnectAttempt = 0;
    sub.scheduleReattach(30_000);
    return;
  }

  // The status endpoint proved the job terminal. Reconcile persisted
  // content before recovering leftovers, just like the 404 path.
  run.cancelSteerRetryFrames();
  let persistedMessages: TMessage[] | undefined;
  try {
    await host.cache.invalidateMessages(recoveryConvoId, 'none');
    if (!sub.isCurrent()) {
      return;
    }
    const fetched = await host.cache.fetchMessages(recoveryConvoId);
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
    host.logger.warn('ResumableSSE', 'Could not reconcile terminal messages after disconnect', {
      conversationId: recoveryConvoId,
      error,
    });
  }

  const authoritativeValues = [
    ...(persistedMessages ?? []),
    ...(status.resumeState?.aggregatedContent ?? status.aggregatedContent ?? []),
  ];
  const confirmedV2Terminal =
    generationProtocolVersion === GENERATION_PROTOCOL_VERSION &&
    supportsGenerationProtocolV2(status);
  const reconciledIds = new Set(host.steers.appliedIds(authoritativeValues));
  host.steers.settleApplied(recoveryConvoId, authoritativeValues);
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
  if (persistedMessages && (generationProtocolVersion === 1 || confirmedV2Terminal)) {
    host.steers.convertLocalToQueued(recoveryConvoId, {
      excludeSteerIds: reconciledIds,
      generationProtocolVersion,
    });
  }

  host.events.resetLive(sub.liveSubmission());
  host.cache.removeActiveJob(currentStreamId);
  clearAttachedGenerationCreatedAt(ctx);
  clearPendingApprovalForTerminal(ctx, recoveryConvoId);
  if (!run.createdStreamIds.has(currentStreamId) && run.optimisticStreamIds.has(currentStreamId)) {
    host.cache.removeConversation(currentStreamId);
  }
  sub.retired = true;
  host.pane.setIsSubmitting(false);
  host.pane.setShowStopButton(false);
  let recoveryOutcome: 'completed' | 'aborted' | 'error' = 'error';
  if (status.status === 'complete' && persistedMessages != null) {
    recoveryOutcome = 'completed';
  } else if (status.status === 'aborted') {
    recoveryOutcome = 'aborted';
  }
  const recoveredResponseMessageId =
    recoveryOutcome === 'completed'
      ? completedResponseMessageId(
          persistedMessages,
          sub.userMessage?.messageId,
          status?.resumeState?.responseMessageId ?? sub.submission.initialResponse?.messageId,
        )
      : undefined;
  host.pane.publishRunEnd({
    conversationId: recoveryConvoId,
    outcome: recoveryOutcome,
    endedAt: run.scheduler.now(),
    generationCreatedAt: status.createdAt ?? generationCreatedAt,
    ...(recoveredResponseMessageId != null && {
      responseMessageId: recoveredResponseMessageId,
    }),
  });
  host.pane.setSubmission(null);
  host.pane.setStreamId(null);
  run.releaseStream(currentStreamId);
  run.reconnectAttempt = 0;
}

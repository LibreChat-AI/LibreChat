import { Constants } from 'librechat-data-provider';
import type { Agents, TPendingSteer } from 'librechat-data-provider';
import type { ResumableHost, StreamStatusResponse } from './host';
import type { GenerationProtocolVersion } from '../protocol';
import type { ResumableSubscription } from './subscription';
import type { ResponsePatcher } from './patches';
import { GENERATION_PROTOCOL_VERSION, supportsGenerationProtocolV2 } from '../protocol';

/** One subscription's terminal handling: the attachment, the app around it, and how a pending
 *  action lands on the response it streams. */
export interface TerminalContext {
  sub: ResumableSubscription;
  host: ResumableHost;
  applyPendingAction: (action: Agents.PendingAction) => void;
}

/** A subscription's terminal handling, plus the patcher that lands its side events. */
export interface StreamContext extends TerminalContext {
  patcher: ResponsePatcher;
}

/**
 * Terminal handlers are fenced by this subscription and its generation. Clear every key the
 * same run may have occupied, including the temporary new-chat key, so aborts and resumes from
 * another tab cannot leave a stale approval card beside an idle composer.
 */
export function clearPendingApprovalForTerminal(
  { sub, host }: TerminalContext,
  conversationId?: string | null,
): void {
  const conversationIds = new Set<string>([
    sub.streamId,
    ...(conversationId ? [conversationId] : []),
    ...(sub.submission.conversation?.conversationId
      ? [sub.submission.conversation.conversationId]
      : []),
    ...(sub.startedAsNewConversation ? [String(Constants.NEW_CONVO)] : []),
  ]);
  for (const id of conversationIds) {
    host.pane.setPendingAction(id, null);
  }
}

/** Releases the epoch this subscription installed, unless a newer one already replaced it. */
export function clearAttachedGenerationCreatedAt({ sub, host }: TerminalContext): void {
  host.pane.setGenerationEpoch(sub.streamId, null, sub.generationCreatedAt);
  if (sub.startedAsNewConversation) {
    host.pane.setGenerationEpoch(Constants.NEW_CONVO, null, sub.generationCreatedAt);
  }
}

/** Seeds the steer chips, settled parts and pending action a live status reports. */
export function restoreLiveStatus(
  { host, applyPendingAction }: TerminalContext,
  conversationId: string,
  status: StreamStatusResponse,
  generationCreatedAt: number | undefined,
  generationProtocolVersion: GenerationProtocolVersion,
): void {
  host.steers.seed(
    conversationId,
    (status.resumeState?.pendingSteers ?? []) as TPendingSteer[],
    generationCreatedAt,
    generationProtocolVersion,
  );
  host.steers.settleApplied(
    conversationId,
    status.resumeState?.aggregatedContent ?? status.aggregatedContent,
  );
  if (status.pendingAction ?? status.resumeState?.pendingAction) {
    applyPendingAction(
      (status.pendingAction ?? status.resumeState?.pendingAction) as Agents.PendingAction,
    );
  }
}

/**
 * Hands this stale attachment to the newer generation now occupying the conversation, when a
 * status read proves one is live. The replacement's snapshot is cached for resume-on-load to
 * build an epoch-fenced submission from; this pane stays non-idle until it does.
 */
export async function handoffToReplacement(
  ctx: TerminalContext,
  conversationId: string,
  knownStatus?: StreamStatusResponse,
): Promise<boolean> {
  const { sub, host } = ctx;
  const { generationCreatedAt } = sub;
  if (!sub.isCurrent() || sub.generationProtocolVersion !== GENERATION_PROTOCOL_VERSION) {
    return false;
  }
  let replacementStatus = knownStatus;
  if (replacementStatus == null) {
    try {
      // Deliberately unfenced: this read discovers the newer generation
      // after the epoch-fenced SSE endpoint rejects the stale attachment.
      replacementStatus = await host.fetchStatus(conversationId);
      if (!sub.isCurrent()) {
        return false;
      }
    } catch (error) {
      if (!sub.isCurrent()) {
        return false;
      }
      host.logger.warn('ResumableSSE', 'Could not inspect replacement generation', {
        conversationId,
        generationCreatedAt,
        error,
      });
      return false;
    }
  }

  if (
    !supportsGenerationProtocolV2(replacementStatus) ||
    replacementStatus.active !== true ||
    !replacementStatus.streamId ||
    replacementStatus.createdAt == null ||
    replacementStatus.createdAt === generationCreatedAt
  ) {
    return false;
  }

  host.logger.log('ResumableSSE', 'Handing stale attachment to replacement generation', {
    conversationId,
    staleCreatedAt: generationCreatedAt,
    replacementCreatedAt: replacementStatus.createdAt,
  });
  const { run } = sub;
  run.replacementHandoff = true;
  run.cancelSteerRetryFrames();
  sub.close();
  run.clearReconnectTimeout();
  host.cache.setStreamStatus(conversationId, {
    ...replacementStatus,
    generationHandoff: true,
  });
  host.pane.setGenerationEpoch(
    conversationId,
    replacementStatus.createdAt,
    undefined,
    GENERATION_PROTOCOL_VERSION,
  );
  if (sub.startedAsNewConversation) {
    host.pane.setGenerationEpoch(
      Constants.NEW_CONVO,
      replacementStatus.createdAt,
      undefined,
      GENERATION_PROTOCOL_VERSION,
    );
  }
  host.cache.addActiveJob(replacementStatus.streamId);
  restoreLiveStatus(
    ctx,
    conversationId,
    replacementStatus,
    replacementStatus.createdAt,
    GENERATION_PROTOCOL_VERSION,
  );
  host.events.resetLive(sub.liveSubmission());
  host.events.clearStepMaps();
  run.reconnectAttempt = 0;
  run.submission = null;
  host.pane.setIsSubmitting(true);
  host.pane.setShowStopButton(true);
  host.pane.setSubmission(null);
  return true;
}

/**
 * A terminal frame proves only what happened on this SSE attachment. A fresh status read is
 * the authority for whether terminal UI teardown is safe: a newer epoch may already own the
 * conversation, while the exact epoch can still be active despite a racing FINAL/error frame.
 */
export function retryFencedTerminalAttachment(
  { sub, host }: TerminalContext,
  reason: string,
): void {
  if (!sub.isCurrent()) {
    return;
  }
  host.logger.warn('ResumableSSE', 'Deferring terminal teardown and retrying fenced attachment', {
    conversationId: sub.conversationId(),
    generationCreatedAt: sub.generationCreatedAt,
    reason,
  });
  const { run } = sub;
  run.reconnectAttempt = Math.max(run.reconnectAttempt, 1);
  sub.close();
  if (run.reconnectTimeout) {
    run.scheduler.clearTimeout(run.reconnectTimeout);
  }
  sub.scheduleReattach(250);
}

/** Whether a terminal frame may tear the pane down, per a fresh status read. */
export async function authorizeTerminalTeardown(
  ctx: TerminalContext,
  conversationId: string,
  terminalKind: 'FINAL' | 'error',
): Promise<boolean> {
  const { sub, host } = ctx;
  const { generationCreatedAt } = sub;
  if (!sub.isCurrent()) {
    return false;
  }
  if (sub.generationProtocolVersion !== GENERATION_PROTOCOL_VERSION) {
    return true;
  }

  let status: StreamStatusResponse;
  try {
    status = await host.fetchStatus(conversationId);
    if (!sub.isCurrent()) {
      return false;
    }
  } catch (error) {
    if (!sub.isCurrent()) {
      return false;
    }
    host.logger.warn('ResumableSSE', `Could not verify ${terminalKind} generation status`, {
      conversationId,
      generationCreatedAt,
      error,
    });
    retryFencedTerminalAttachment(ctx, `${terminalKind.toLowerCase()} status unavailable`);
    return false;
  }

  if (!supportsGenerationProtocolV2(status)) {
    retryFencedTerminalAttachment(ctx, `${terminalKind.toLowerCase()} status was unnegotiated`);
    return false;
  }

  if (status.active === true) {
    const handedOff =
      status.createdAt != null &&
      generationCreatedAt != null &&
      status.createdAt !== generationCreatedAt &&
      (await handoffToReplacement(ctx, conversationId, status));
    if (!sub.isCurrent()) {
      return false;
    }
    if (handedOff) {
      return false;
    }
    retryFencedTerminalAttachment(
      ctx,
      status.createdAt == null || generationCreatedAt == null
        ? `${terminalKind.toLowerCase()} status epoch was inconclusive`
        : `${terminalKind.toLowerCase()} generation remains active`,
    );
    return false;
  }

  if (status.active !== false) {
    retryFencedTerminalAttachment(ctx, `${terminalKind.toLowerCase()} status was inconclusive`);
    return false;
  }

  return true;
}

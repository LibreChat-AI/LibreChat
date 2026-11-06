import { Constants, StepEvents } from 'librechat-data-provider';
import type {
  TMessage,
  ChatEvent,
  TAttachment,
  TPendingSteer,
  ChatFinalFrame,
  EventSubmission,
  ChatCreatedFrame,
} from 'librechat-data-provider';
import type { StreamContext } from './terminal';
import type { StepEvent } from '../reducer';
import {
  authorizeTerminalTeardown,
  clearPendingApprovalForTerminal,
  clearAttachedGenerationCreatedAt,
} from './terminal';
import { GENERATION_PROTOCOL_VERSION, supportsGenerationProtocolV2 } from '../protocol';
import { isInitialNewConversation, buildCreatedInitialResponse } from './messages';
import { reconcileGenerationLifecycle } from './reconcile';
import { ABORT_SWEEP_STATUSES } from '../steer/chips';
import { isOAuthStepEvent } from './events';
import { handleSync } from './sync';

export function handleOpen({ sub, host }: StreamContext): void {
  const { run, generationCreatedAt } = sub;
  if (!sub.isCurrent()) {
    return;
  }
  host.logger.log('ResumableSSE', 'Stream connected');
  host.pane.setAbortScroll(false);
  // Restore UI state on successful connection (including reconnection)
  host.pane.setIsSubmitting(true);
  host.pane.setShowStopButton(generationCreatedAt != null);
  run.reconnectAttempt = 0;
}

/** The run's ordinary final: settles steers, writes the final response and publishes the end. */
async function handleFinal(ctx: StreamContext, data: ChatFinalFrame): Promise<void> {
  const { sub, host } = ctx;
  const { run, generationCreatedAt, generationProtocolVersion } = sub;
  const currentStreamId = sub.streamId;
  sub.finalReceived = true;
  const finalConvoId =
    data.conversation?.conversationId ??
    sub.submission.conversation?.conversationId ??
    currentStreamId;
  if (!(await authorizeTerminalTeardown(ctx, finalConvoId, 'FINAL')) || !sub.isCurrent()) {
    return;
  }
  run.cancelSteerRetryFrames();
  run.clearReconnectTimeout();
  run.reconnectAttempt = 0;
  host.logger.log('ResumableSSE', 'Received FINAL event', {
    aborted: data.aborted,
    conversationId: data.conversation?.conversationId,
    hasResponseMessage: !!data.responseMessage,
  });
  clearPendingApprovalForTerminal(ctx, finalConvoId);
  host.pane.clearComposerDrafts(sub.submission.conversation?.conversationId, {
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
    host.steers.appliedIds(data.responseMessage ? [data.responseMessage] : []),
  );
  host.steers.settleApplied(
    finalConvoId,
    data.responseMessage ? [data.responseMessage] : undefined,
  );
  // Steers the run never injected ride the final event; convert them
  // to queued follow-ups before the run-end signal fires the drain
  // (also resets the applied-id set for the finished run).
  // `claimParked` reconciles the replayable parked copy of the same
  // steers; explicit dismissal or a persisted recovery removes it.
  host.steers.convertToQueued(
    finalConvoId,
    (generationProtocolVersion === 1 || supportsGenerationProtocolV2(data)) &&
      Array.isArray(data.pendingSteers)
      ? (data.pendingSteers as TPendingSteer[]).filter(
          (steer) =>
            !finalAppliedSteerIds.has(steer.steerId) &&
            (steer.clientSteerId == null || !finalAppliedSteerIds.has(steer.clientSteerId)),
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
  host.steers.convertLocalToQueued(finalConvoId);
  let finalHandled = false;
  try {
    host.events.finalHandler(data, sub.submission as EventSubmission);
    finalHandled = true;
    host.usage.finalizeUsage(data, sub.liveSubmission());
  } catch (error) {
    host.logger.error('ResumableSSE', 'Error in finalHandler:', error);
    host.pane.setIsSubmitting(false);
    host.pane.setShowStopButton(false);
  }
  // One-shot run-end signal for the queue drain. Written AFTER
  // finalHandler so `isSubmitting` has flipped false by the time the
  // drain effect observes it (both land in the same Recoil batch).
  // An early-aborted FIRST turn keys under NEW_CONVO: finalHandler
  // restored /c/new, so the optimistic id would strand the queue.
  const runEndTarget = host.pane.runEndTarget({
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
  host.pane.publishRunEnd({
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
  host.events.clearStepMaps();
  // Optimistically remove from active jobs
  host.cache.removeActiveJob(currentStreamId);
  clearAttachedGenerationCreatedAt(ctx);
  host.pane.refreshBalance();
  sub.close();
  host.pane.setStreamId(null);
  run.releaseStream(currentStreamId);
}

/** The server named the turn: adopt its user message and the response placeholder under it. */
function handleCreated(ctx: StreamContext, data: ChatCreatedFrame): void {
  const { sub, host, patcher } = ctx;
  const { run, generationCreatedAt, startedAsNewConversation } = sub;
  const currentStreamId = sub.streamId;
  host.logger.log('ResumableSSE', 'Received CREATED event', {
    messageId: data.message?.messageId,
    conversationId: data.message?.conversationId,
  });
  run.createdStreamIds.add(currentStreamId);
  if (startedAsNewConversation) {
    host.pane.setGenerationEpoch(Constants.NEW_CONVO, null, generationCreatedAt);
  }
  host.pane.renewActiveRun();
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
  host.usage.bindResponse(sub.submission);
  host.events.createdHandler(data, sub.submission as EventSubmission);
  patcher.replayPreCreatedStepEvents();
}

/** Routes one stream frame to its handler, fenced by the subscription. */
export async function handleFrame(ctx: StreamContext, event: ChatEvent): Promise<void> {
  const { sub, host, patcher } = ctx;
  const { run, isResume, generationProtocolVersion } = sub;
  const currentStreamId = sub.streamId;
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
        host.logger.warn('ResumableSSE', 'Ignoring unnegotiated lifecycle reconciliation frame');
        return;
      }
      // Synthesized lifecycle frames deliberately carry no ordinary
      // response payload. Reconcile durable history (or hand off to a
      // replacement epoch) instead of passing them to finalHandler.
      sub.finalReceived = true;
      run.cancelSteerRetryFrames();
      void reconcileGenerationLifecycle(ctx, data);
      return;
    }

    if (event.type === 'final') {
      await handleFinal(ctx, event.data);
      return;
    }

    if (event.type === 'created') {
      handleCreated(ctx, event.data);
      return;
    }

    if (event.type === 'attachment' && event.data) {
      host.events.attachmentHandler({
        data: event.data as TAttachment,
        submission: sub.submission as EventSubmission,
      });
      return;
    }

    if (event.type === 'title') {
      host.events.titleHandler(event.data);
      return;
    }

    if (event.type === 'context_usage') {
      host.usage.contextHandler(event.data, sub.liveSubmission());
      return;
    }

    if (event.type === 'token_usage') {
      host.usage.usageHandler(event.data, sub.liveSubmission());
      return;
    }

    if (event.type === 'pending_action') {
      patcher.applyPendingAction(event.data);
      host.pane.setIsSubmitting(true);
      return;
    }

    if (event.type === 'steer_applied') {
      patcher.applySteer(event.data);
      return;
    }

    if (event.type === 'steer_updated') {
      host.steers.update(event.data);
      return;
    }

    if (event.type === 'activity_label') {
      patcher.applyActivityLabel(event.data);
      return;
    }

    if (event.type === 'reasoning_label') {
      patcher.applyReasoningLabel(event.data);
      return;
    }

    if (event.type === 'step') {
      const data = event.data as StepEvent;
      if (
        data.event === StepEvents.ON_MESSAGE_DELTA ||
        data.event === StepEvents.ON_REASONING_DELTA
      ) {
        host.usage.tapStream(data.data, sub.liveSubmission());
      }
      if (!isResume && !run.createdStreamIds.has(currentStreamId)) {
        if (isOAuthStepEvent(data)) {
          sub.preCreatedStepEvents.push(data);
          host.events.stepHandler(data, sub.liveSubmission() as EventSubmission);
          return;
        }
        sub.preCreatedStepEvents.push(data);
        return;
      }
      host.events.stepHandler(data, sub.liveSubmission() as EventSubmission);
      return;
    }

    if (event.type === 'sync') {
      handleSync(ctx, event.data);
      return;
    }

    if (event.type === 'content') {
      const { data } = event;
      const { index } = data;
      const text = 'text' in data ? data.text : undefined;
      if (text != null && index !== sub.textIndex) {
        sub.textIndex = index;
      }
      host.usage.tapContent(text, sub.liveSubmission());
      host.events.contentHandler({ data, submission: sub.submission as EventSubmission });
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
      host.usage.tapContent(text, textSubmission);
      host.events.messageHandler(text, textSubmission);
    }
  } catch (error) {
    host.logger.error('ResumableSSE', 'Error processing message:', error);
  }
}

/**
 * The transport emits `abort` only for this hook's own closes. A cancel
 * the user agent issued (a backgrounded or frozen mobile tab, while the
 * generation keeps running server-side) arrives as an `error` with status
 * 0 instead, so it climbs the same reconnect ladder as any dropped
 * connection rather than stranding the pane on its partial content.
 */
export function handleClose({ sub, host }: StreamContext): void {
  const { run } = sub;
  const currentStreamId = sub.streamId;
  if (!sub.isCurrent()) {
    return;
  }

  if (run.replacementHandoff) {
    host.logger.log('ResumableSSE', 'Stream closed for generation handoff - preserving state');
    return;
  }
  // If we're in a reconnection cycle, don't reset state
  // (error handler will set up the reconnect timeout)
  if (run.reconnectAttempt > 0) {
    host.logger.log('ResumableSSE', 'Stream closed for reconnect - preserving state');
    return;
  }

  host.logger.log('ResumableSSE', 'Stream aborted (intentional close) - no reconnect');
  run.cancelSteerRetryFrames();
  // Clear any pending reconnect attempts
  run.clearReconnectTimeout();
  // Reset UI state - useResumeOnLoad will restore if user returns to this conversation
  host.pane.setIsSubmitting(false);
  host.pane.setShowStopButton(false);
  host.pane.setStreamId(null);
  /** Intentional close without a final event (explicit stop, or navigation
   *  while generating): discard the in-flight pending usage so it can't
   *  merge into the next response in this conversation. On a resume the
   *  collected usage is re-folded via backfillUsage, so nothing is lost. */
  host.events.resetLive(sub.liveSubmission());
  // No final/error event fires on this path, so it's the only place left
  // to sweep a local `failed` chip; otherwise it survives this close and
  // renders (with a live Retry) under whatever run starts next. `pending`
  // chips are deliberately left alone here: this listener also fires on
  // navigation away while the run CONTINUES server-side, so a
  // server-ACK'd `pending` steer is not stranded: the server injects it
  // regardless, and sweeping it into the queue too would resend the same
  // words as a duplicate turn once `useQueueDrain` fires at run end.
  host.steers.convertLocalToQueued(sub.submission.conversation?.conversationId ?? currentStreamId, {
    statuses: ABORT_SWEEP_STATUSES,
  });
}

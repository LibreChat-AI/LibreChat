import {
  StepEvents,
  UsageEvents,
  SteerEvents,
  ApprovalEvents,
  ActivityLabelEvents,
  ReasoningLabelEvents,
} from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  ChatSyncFrame,
  TPendingSteer,
  TTokenUsageEvent,
  TContextUsageEvent,
  TSteerAppliedEvent,
  TSteerUpdatedEvent,
  TActivityLabelEvent,
  TReasoningLabelEvent,
} from 'librechat-data-provider';
import type { StreamContext } from './terminal';
import type { StepEvent } from '../reducer';
import { getResumeMessageIndexes, mergeResumeMessages } from './placement';
import { getStepEventId, isOAuthStepEvent } from './events';
import { buildResumeEventSubmission } from './resume';
import { preferDefinedString } from './messages';

/**
 * A resume's snapshot of the run: adopts the server's identity for the turn, rebuilds the
 * response from the aggregated content, re-applies pending prompts, steers and labels, and
 * replays the events the snapshot did not cover.
 */
export function handleSync(ctx: StreamContext, data: ChatSyncFrame): void {
  const { sub, host, patcher } = ctx;
  const { run, generationCreatedAt, generationProtocolVersion } = sub;
  const currentStreamId = sub.streamId;
  host.logger.log('ResumableSSE', 'SYNC received', {
    runSteps: data.resumeState?.runSteps?.length ?? 0,
    pendingEvents: data.pendingEvents?.length ?? 0,
  });

  host.pane.renewActiveRun();
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
  host.usage.backfillUsage(data.resumeState?.collectedUsage ?? [], resumeSubmission);
  if (data.resumeState?.contextUsage) {
    /** Already reconciled to the call's real prompt tokens server-side
     *  (GenerationJobManager.persistTokenUsage) when the snapshot's call
     *  completed, so install it as-is: no client backfill reconcile. */
    host.usage.contextHandler(data.resumeState.contextUsage, resumeSubmission);
  }
  /** Output streamed before this resume is not re-delivered as deltas;
   *  estimate it from the trailing aggregated content. This is
   *  needed even with a snapshot: the snapshot is pre-invoke, so the
   *  in-flight output it precedes rides on the live estimate.
   *  Only output at the very end counts (0
   *  when paused at a tool call), so a snapshot's budget is never
   *  double-counted. */
  host.usage.seedLiveFromContent(data.resumeState?.aggregatedContent, resumeSubmission);

  const pendingOAuthPrompts = data.resumeState?.pendingOAuthPrompts ?? [];
  const pendingOAuthStepIds = new Set(pendingOAuthPrompts.map((prompt) => prompt.stepId));
  if (data.resumeState?.runSteps) {
    for (const runStep of data.resumeState.runSteps) {
      if (pendingOAuthStepIds.has(runStep.id)) {
        continue;
      }
      host.events.stepHandler({ event: StepEvents.ON_RUN_STEP, data: runStep }, resumeSubmission);
    }
  }

  if (data.resumeState?.aggregatedContent && sub.userMessage?.messageId) {
    const messages = host.messages.get() ?? [];
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

    host.logger.log('ResumableSSE', 'SYNC update', {
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
      host.logger.log('ResumableSSE', 'SYNC updating message', {
        messageId: responseMessage.messageId,
        oldContentLength: Array.isArray(oldContent) ? oldContent.length : 0,
        newContentLength: data.resumeState.aggregatedContent?.length,
        preservedExistingContent: preserveLoadedContent,
      });
      host.messages.set(updated);
      host.events.resetContentHandler();
      host.events.syncStepMessage(responseMessage);
      host.logger.log('ResumableSSE', 'SYNC complete, handlers synced');
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
      host.messages.set(
        mergeResumeMessages(
          messages,
          sub.userMessage,
          newMessage,
          messageIndexes,
          resumeSubmission.compact === true,
        ),
      );
      host.events.resetContentHandler();
      host.events.syncStepMessage(newMessage);
    }
  }

  for (const prompt of pendingOAuthPrompts) {
    patcher.applyPendingOAuthPrompt(prompt, resumeSubmission);
  }

  /**
   * Re-pause on reconnect: the run is parked on a human-review
   * interrupt. Re-apply the pending action so the approval / ask-user
   * controls render after a reload or dropped connection.
   */
  if (data.resumeState?.pendingAction) {
    patcher.applyPendingAction(data.resumeState.pendingAction as Agents.PendingAction);
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
  host.steers.seed(
    steerConvoId,
    (data.resumeState?.pendingSteers ?? []) as TPendingSteer[],
    generationCreatedAt,
    generationProtocolVersion,
  );
  // Seed first, then remove anything already represented in the
  // authoritative content. Reversing this order can re-mint a stale
  // server snapshot entry after it was just settled.
  host.steers.settleApplied(
    steerConvoId,
    data.resumeState?.aggregatedContent as unknown[] | undefined,
  );

  if (data.resumeState?.titleEvent) {
    host.events.titleHandler(data.resumeState.titleEvent);
  }

  /** PTC inner calls are not content parts, so the resume snapshot
   *  can't rebuild them and a settling event lost in this gap is
   *  never replayed. Mark rows still `running` as interrupted rather
   *  than leave a spinner that never resolves, and rather than drop
   *  them, since a call still executing across the reconnect settles
   *  normally on the restored stream and updates its row in place. */
  host.events.prunePtcTraces();

  const replayEvents = data.resumeState?.replayEvents ?? [];
  if (replayEvents.length > 0) {
    host.logger.log('ResumableSSE', `Replaying ${replayEvents.length} resume events`);
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
        host.usage.contextHandler(replayEvent.data as TContextUsageEvent, resumeSubmission);
      } else if (replayEvent.event === UsageEvents.ON_TOKEN_USAGE) {
        host.usage.usageHandler(replayEvent.data as TTokenUsageEvent, resumeSubmission);
      } else if (replayEvent.event === ApprovalEvents.ON_PENDING_ACTION) {
        // A pause that landed after the resume snapshot must still render its
        // controls (mirror the live handler), not fall through to stepHandler.
        patcher.applyPendingAction(replayEvent.data as Agents.PendingAction);
      } else if (replayEvent.event === SteerEvents.ON_STEER_APPLIED) {
        patcher.applySteer(replayEvent.data as TSteerAppliedEvent);
      } else if (replayEvent.event === SteerEvents.ON_STEER_UPDATED) {
        host.steers.update(replayEvent.data as TSteerUpdatedEvent);
      } else if (replayEvent.event === ActivityLabelEvents.ON_ACTIVITY_LABEL) {
        patcher.applyActivityLabel(replayEvent.data as TActivityLabelEvent);
      } else if (replayEvent.event === ReasoningLabelEvents.ON_REASONING_LABEL) {
        patcher.applyReasoningLabel(replayEvent.data as TReasoningLabelEvent);
      } else if (replayEvent.event === ReasoningLabelEvents.ON_REASONING_LABEL_ATTEMPT) {
        // Durable provider-call budget reservations never render.
      } else if (replayEvent.event != null) {
        if (
          replayEvent.event === StepEvents.ON_MESSAGE_DELTA ||
          replayEvent.event === StepEvents.ON_REASONING_DELTA
        ) {
          host.usage.tapStream(replayEvent.data as Agents.MessageDeltaEvent, resumeSubmission);
        }
        host.events.stepHandler(replayEvent as StepEvent, resumeSubmission);
      }
    }
  }

  const pendingEvents = data.pendingEvents ?? [];
  if (pendingEvents.length > 0) {
    host.logger.log('ResumableSSE', `Replaying ${pendingEvents.length} pending events`);
    for (const pendingEvent of pendingEvents) {
      if (!('event' in pendingEvent)) {
        if ('type' in pendingEvent) {
          /** Gap output streamed past the resume snapshot must reach the
           *  live estimate too, not just the message UI */
          host.usage.tapContent(
            'text' in pendingEvent ? pendingEvent.text : undefined,
            resumeSubmission,
          );
          host.events.contentHandler({ data: pendingEvent, submission: resumeSubmission });
        }
        continue;
      }
      if (pendingEvent.event === 'title') {
        host.events.titleHandler(pendingEvent);
      } else if (pendingEvent.event === UsageEvents.ON_CONTEXT_USAGE) {
        host.usage.contextHandler(pendingEvent.data, resumeSubmission);
      } else if (pendingEvent.event === UsageEvents.ON_TOKEN_USAGE) {
        host.usage.usageHandler(pendingEvent.data, resumeSubmission);
      } else if (pendingEvent.event === ApprovalEvents.ON_PENDING_ACTION) {
        // In-memory mode can surface a pause that landed between getResumeState()
        // and the subscription here; route it to the same handler as a live event
        // so the approval / ask-user controls render (else the stream sits paused
        // with no UI until a full status reload).
        patcher.applyPendingAction(pendingEvent.data as Agents.PendingAction);
      } else if (pendingEvent.event === SteerEvents.ON_STEER_APPLIED) {
        patcher.applySteer(pendingEvent.data as TSteerAppliedEvent);
      } else if (pendingEvent.event === SteerEvents.ON_STEER_UPDATED) {
        host.steers.update(pendingEvent.data as TSteerUpdatedEvent);
      } else if (pendingEvent.event === ActivityLabelEvents.ON_ACTIVITY_LABEL) {
        patcher.applyActivityLabel(pendingEvent.data as TActivityLabelEvent);
      } else if (pendingEvent.event === ReasoningLabelEvents.ON_REASONING_LABEL) {
        patcher.applyReasoningLabel(pendingEvent.data as TReasoningLabelEvent);
      } else if (pendingEvent.event === ReasoningLabelEvents.ON_REASONING_LABEL_ATTEMPT) {
        // Durable provider-call budget reservations never render.
      } else if (pendingEvent.event != null) {
        if (
          pendingEvent.event === StepEvents.ON_MESSAGE_DELTA ||
          pendingEvent.event === StepEvents.ON_REASONING_DELTA
        ) {
          host.usage.tapStream(pendingEvent.data, resumeSubmission);
        }
        host.events.stepHandler(pendingEvent as StepEvent, resumeSubmission);
      }
    }
  }

  host.pane.setIsSubmitting(true);
  host.pane.setShowStopButton(generationCreatedAt != null);
}

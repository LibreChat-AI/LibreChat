import { Constants, StepTypes, StepEvents } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import type { StepEvent, StepEffect, StepContext, StreamState } from './stream/state';
import {
  isOAuthToolCallName,
  getEditPrefix,
  applyAgentUpdate,
  applySummaryStep,
  applyMessageDelta,
  finalizeSummaries,
  applyToolCallsStep,
  applyReasoningDelta,
  applySummarizeDelta,
  applyToolCallCompleted,
  isSkillAuthoringToolCall,
} from './steps';
import {
  ensureUserMessagePresent,
  getEventMessages,
  getResponseBaseMessages,
  mergeResponseMessage,
  shouldRemoveInitialResponse,
  shouldRemoveRegenerateResponse,
} from './stream/merge';
import {
  applyRunStepDelta,
  applyToolPreparation,
  applyToolCallsDispatched,
  applyRunStepClosedTiming,
} from './stream/timing';
import { toolTimingKey, resolveResponseId, bufferDelta } from './stream/state';
import { claimSubagentUpdate } from './stream/subagent';

export type { StepEvent, StepEffect, StepContext, StreamState } from './stream/state';
export { createStreamState, resetStreamState, subagentProgressKey } from './stream/state';
export { mergeResponseMessage, flushResponses, flushSummary } from './stream/merge';
export { syncStreamMessage } from './stream/subagent';

/**
 * The step reducer behind `useStepHandler`: folds one agent step event into the response message
 * it targets and reports every write outside the message list as an effect.
 *
 * Message writes go through `StepContext.setMessages` as they happen, because later writes in the
 * same event read the list back through `getMessages`. Everything else (live-status stores,
 * announcements, cache invalidation, coalesced flushes) is returned in order for the binding.
 *
 * Model parts retain their absolute step indices plus the edit prefix. Synthetic OAuth
 * prompts follow those model parts and are addressed separately by identity.
 */

export function reduceStep(state: StreamState, event: StepEvent, ctx: StepContext): StepEffect[] {
  const { submission } = ctx;
  const messages = getEventMessages(ctx, submission.messages ?? []);
  const { userMessage } = submission;
  const effects: StepEffect[] = [];
  const merge = (updated: TMessage, responseMessageId: string) =>
    ctx.setMessages(
      mergeResponseMessage(ctx, messages, updated, responseMessageId, { ensureUserMessage: true }),
    );

  /** Activity labels honor the same `editPrefixCleared` flag `getEditPrefix` reads, so a batch's
   *  tool cards and its header land in one index space. */
  const { initialContent, editPrefixOffset } = getEditPrefix(submission);

  if (event.event === StepEvents.ON_RUN_STEP) {
    let runStep = event.data;
    if (runStep.runId !== Constants.USE_PRELIM_RESPONSE_MESSAGE_ID && runStep.runId) {
      state.currentResponseId = runStep.runId;
    } else if (
      runStep.runId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID &&
      state.currentResponseId &&
      runStep.stepDetails.type === StepTypes.TOOL_CALLS &&
      runStep.stepDetails.tool_calls?.some(
        (call) => 'name' in call && isOAuthToolCallName(call.name),
      )
    ) {
      runStep = { ...runStep, runId: state.currentResponseId };
    }
    let parentMessageId =
      submission.isRegenerate && submission.initialResponse?.parentMessageId
        ? submission.initialResponse.parentMessageId
        : userMessage.messageId;
    let responseMessageId = runStep.runId ?? '';
    if (responseMessageId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID) {
      responseMessageId = submission?.initialResponse?.messageId ?? '';
      parentMessageId = submission?.initialResponse?.parentMessageId ?? '';
    }
    if (!responseMessageId) {
      console.warn('No message id found in run step event');
      return effects;
    }

    state.steps.set(runStep.id, runStep);

    let response = state.messages.get(responseMessageId);

    if (!response) {
      /** Regenerate can target an earlier branch while the visible history still ends at a later
       *  assistant message, so a regenerated response is never seeded from the tail. */
      const lastMessage = messages[messages.length - 1] as TMessage;
      const responseMessage =
        !submission.isRegenerate && lastMessage && !lastMessage.isCreatedByUser
          ? lastMessage
          : (submission?.initialResponse as TMessage);

      /** An edit's `initialContent` IS the starting content; a resume starts from what exists. */
      const existingContent = responseMessage?.content ?? [];
      const mergedContent: TMessageContentParts[] =
        initialContent.length > 0 ? initialContent : existingContent;

      response = {
        ...responseMessage,
        parentMessageId,
        conversationId: userMessage.conversationId,
        messageId: responseMessageId,
        content: mergedContent,
      };

      state.messages.set(responseMessageId, response);

      /** Fresh read: another tab may have loaded more history since the handler started. */
      const currentMessages = getResponseBaseMessages(ctx, messages, responseMessageId, true);

      let updatedMessages = currentMessages.filter(
        (message) =>
          message.messageId !== responseMessageId &&
          !shouldRemoveRegenerateResponse(submission, message, responseMessageId) &&
          !shouldRemoveInitialResponse(submission, message, responseMessageId),
      );

      /** Regenerate reuses an existing user turn; its submission userMessage is only a transport
       *  placeholder and must not become a new visible branch. */
      updatedMessages = ensureUserMessagePresent(submission, updatedMessages, responseMessageId);

      ctx.setMessages([...updatedMessages, response]);
    }

    if (runStep.stepDetails.type === StepTypes.TOOL_CALLS) {
      const { message: updatedResponse, toolCallId } = applyToolCallsStep(
        response,
        runStep,
        editPrefixOffset,
        (callId) => ({
          toolPreparationStartedAt:
            state.firstFragmentByCall.get(toolTimingKey(runStep.id, callId)) ??
            (runStep.stepDetails.type === StepTypes.TOOL_CALLS &&
            (runStep.stepDetails.tool_calls?.length ?? 0) <= 1
              ? state.firstFragmentByStep.get(runStep.id)
              : undefined),
          toolDispatchedAt: state.dispatchedByCall.get(toolTimingKey(runStep.id, callId)),
        }),
      );
      if (toolCallId) {
        state.toolCallIds.set(runStep.id, toolCallId);
      }
      state.messages.set(responseMessageId, updatedResponse);
      merge(updatedResponse, responseMessageId);
    }

    if (runStep.summary != null) {
      const updatedResponse = applySummaryStep(
        state.messages.get(responseMessageId) ?? response,
        runStep,
        editPrefixOffset,
      );
      state.messages.set(responseMessageId, updatedResponse);
      merge(updatedResponse, responseMessageId);
    }

    const bufferedDeltas = state.pendingDeltas.get(runStep.id);
    if (bufferedDeltas && bufferedDeltas.length > 0) {
      state.pendingDeltas.delete(runStep.id);
      for (const bufferedDelta of bufferedDeltas) {
        effects.push(...reduceStep(state, bufferedDelta, ctx));
      }
    }
    return effects;
  }

  if (event.event === StepEvents.ON_AGENT_UPDATE) {
    const responseMessageId = resolveResponseId(submission, event.data.agent_update.runId || '');
    if (!responseMessageId) {
      console.warn('No message id found in agent update event');
      return effects;
    }
    const response = state.messages.get(responseMessageId);
    if (response) {
      const updatedResponse = applyAgentUpdate(response, event.data, editPrefixOffset);
      state.messages.set(responseMessageId, updatedResponse);
      merge(updatedResponse, responseMessageId);
    }
    return effects;
  }

  if (
    event.event === StepEvents.ON_MESSAGE_DELTA ||
    event.event === StepEvents.ON_REASONING_DELTA
  ) {
    const delta = event.data;
    const runStep = state.steps.get(delta.id);
    const responseMessageId = resolveResponseId(submission, runStep?.runId);
    if (!runStep || !responseMessageId) {
      bufferDelta(state, delta.id, event);
      return effects;
    }
    const response = state.messages.get(responseMessageId);
    if (!response) {
      return effects;
    }
    const result =
      event.event === StepEvents.ON_MESSAGE_DELTA
        ? applyMessageDelta(response, runStep, event.data, editPrefixOffset)
        : applyReasoningDelta(response, runStep, event.data, editPrefixOffset);
    if (result.foldedEditPrefix && submission != null) {
      submission.editPrefixFirstPartFolded = true;
    }
    if (result.updated) {
      state.messages.set(responseMessageId, result.message);
      effects.push({ type: 'flush', messageId: responseMessageId, messages });
    }
    return effects;
  }

  if (event.event === StepEvents.ON_TOOL_PREPARATION) {
    applyToolPreparation({ state, data: event.data, ctx, merge, editPrefixOffset });
    return effects;
  }

  if (event.event === StepEvents.ON_RUN_STEP_DELTA) {
    applyRunStepDelta({ state, data: event.data, ctx, merge, editPrefixOffset, event });
    return effects;
  }

  if (event.event === StepEvents.ON_TOOL_CALLS_DISPATCHED) {
    applyToolCallsDispatched({ state, data: event.data, ctx, merge, editPrefixOffset });
    return effects;
  }

  if (event.event === StepEvents.ON_RUN_STEP_COMPLETED) {
    const { result } = event.data;
    const { id: stepId } = result;
    const completedCallId = result.tool_call?.id;
    if (
      completedCallId &&
      typeof result.completed_at === 'number' &&
      Number.isFinite(result.completed_at)
    ) {
      state.completedByCall.set(toolTimingKey(stepId, completedCallId), result.completed_at);
    }
    effects.push({ type: 'sandbox-settled', toolCallId: completedCallId });

    const runStep = state.steps.get(stepId);
    const responseMessageId = resolveResponseId(submission, runStep?.runId);
    if (!runStep || !responseMessageId) {
      bufferDelta(state, stepId, event);
      return effects;
    }

    if (isSkillAuthoringToolCall(result.tool_call)) {
      effects.push({ type: 'skill-authored' });
    }

    const response = state.messages.get(responseMessageId);
    if (response) {
      const updatedResponse = applyToolCallCompleted(response, runStep, result, editPrefixOffset);
      state.messages.set(responseMessageId, updatedResponse);
      merge(updatedResponse, responseMessageId);
    }
    return effects;
  }

  if (event.event === StepEvents.ON_RUN_STEP_CLOSED) {
    applyRunStepClosedTiming({ state, data: event.data, ctx, merge, editPrefixOffset });
    return effects;
  }

  if (event.event === StepEvents.ON_SANDBOX_STARTING) {
    effects.push({ type: 'sandbox-starting', toolCallId: event.data.tool_call_id });
    return effects;
  }

  if (event.event === StepEvents.ON_PTC_TOOL_CALL) {
    /** `runId` is the response message id (the run configurable's `run_id`), the same
     *  correlation the subagent path uses. */
    effects.push({
      type: 'ptc',
      event: event.data,
      parentMessageId: resolveResponseId(submission, event.data.runId),
    });
    return effects;
  }

  if (event.event === StepEvents.ON_SUBAGENT_UPDATE) {
    const { phase } = event.data;
    effects.push(
      ...claimSubagentUpdate(state, event.data, resolveResponseId(submission, event.data.runId)),
    );
    if (phase === 'start' || phase === 'stop' || phase === 'error') {
      const conversationId = [
        submission?.userMessage?.conversationId,
        submission?.initialResponse?.conversationId,
        submission?.conversation?.conversationId,
      ].find((id) => id && id !== Constants.NEW_CONVO && id !== Constants.PENDING_CONVO);
      if (conversationId) effects.push({ type: 'subagent-index', conversationId });
    }
    return effects;
  }

  if (event.event === StepEvents.ON_SUMMARIZE_START) {
    effects.push({ type: 'announce', message: 'summarize_started' });
    return effects;
  }

  if (event.event === StepEvents.ON_SUMMARIZE_DELTA) {
    const deltaData = event.data;
    const runStep = state.steps.get(deltaData.id);
    const responseMessageId = resolveResponseId(submission, runStep?.runId);
    if (!runStep || !responseMessageId) {
      bufferDelta(state, deltaData.id, event);
      return effects;
    }
    const response = state.messages.get(responseMessageId);
    if (response) {
      state.messages.set(
        responseMessageId,
        applySummarizeDelta(response, runStep, deltaData, editPrefixOffset),
      );
      effects.push({ type: 'summary', messageId: responseMessageId, messages });
    }
    return effects;
  }

  if (event.event === StepEvents.ON_SUMMARIZE_COMPLETE) {
    const completeData = event.data;
    const completeRunStep = state.steps.get(completeData.id);
    const completeMessageId = resolveResponseId(submission, completeRunStep?.runId);
    const targetMessage = state.messages.get(completeMessageId);
    if (!targetMessage) {
      return effects;
    }
    /** Scoped to the owning step's slot when the step is known; see `finalizeSummaries`. */
    const completeIndex = completeRunStep != null ? completeRunStep.index + editPrefixOffset : -1;
    const finalized = finalizeSummaries(targetMessage, completeData, completeIndex);
    if (finalized) {
      effects.push({
        type: 'announce',
        message: completeData.error ? 'summarize_failed' : 'summarize_completed',
      });
      const currentMessages = submission.isRegenerate ? messages : ctx.getMessages() || [];
      state.messages.set(completeMessageId, finalized);
      ctx.setMessages(mergeResponseMessage(ctx, currentMessages, finalized, completeMessageId));
    }
    return effects;
  }

  const _exhaustive: never = event;
  console.warn('Unhandled step event', (_exhaustive as StepEvent).event);
  return effects;
}

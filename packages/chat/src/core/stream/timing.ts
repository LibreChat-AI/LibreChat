import { StepTypes, ContentTypes, getToolTimingDurations } from 'librechat-data-provider';
import type { Agents, TMessage } from 'librechat-data-provider';
import type { StepEvent, StepContext, StreamState } from './state';
import { toolTimingKey, isValidTime, resolveResponseId, bufferDelta } from './state';
import { applyToolCallDelta, applyRunStepClosed } from '../steps';

/** Writes `updated` into the list as the response `responseMessageId`. */
export type MergeResponse = (updated: TMessage, responseMessageId: string) => void;

type TimingArgs<T> = {
  state: StreamState;
  data: T;
  ctx: StepContext;
  merge: MergeResponse;
  editPrefixOffset: number;
};

export function applyToolPreparation({
  state,
  data,
  ctx,
  merge,
  editPrefixOffset,
}: TimingArgs<Agents.ToolPreparationMarker>): void {
  const { submission } = ctx;
  const { id, index, toolCallId, observed_at: at } = data;
  if (!id || !isValidTime(at)) return;
  const runStep = state.steps.get(id);
  const declaredCalls =
    runStep?.stepDetails.type === StepTypes.TOOL_CALLS ? runStep.stepDetails.tool_calls : undefined;
  const resolvedId =
    toolCallId ?? (index === 0 && declaredCalls?.length === 1 ? declaredCalls[0]?.id : undefined);
  if (resolvedId) {
    const key = toolTimingKey(id, resolvedId);
    state.firstFragmentByCall.set(key, Math.min(state.firstFragmentByCall.get(key) ?? at, at));
  } else if (index === 0) {
    state.firstFragmentByStep.set(id, Math.min(state.firstFragmentByStep.get(id) ?? at, at));
  }
  if (!runStep?.runId || (runStep.status && runStep.status !== 'in_progress')) return;
  const responseId = resolveResponseId(submission, runStep.runId);
  const response = state.messages.get(responseId);
  const contentIndex = runStep.index + editPrefixOffset;
  const part = response?.content?.[contentIndex];
  if (
    !response ||
    part?.type !== ContentTypes.TOOL_CALL ||
    part.tool_call.runStepStatus != null ||
    (resolvedId && part.tool_call.id !== resolvedId)
  ) {
    return;
  }
  const content = [...(response.content ?? [])];
  content[contentIndex] = {
    ...part,
    tool_call: {
      ...part.tool_call,
      toolPreparationStartedAt: Math.min(part.tool_call.toolPreparationStartedAt ?? at, at),
    },
  };
  const updated = { ...response, content };
  state.messages.set(responseId, updated);
  merge(updated, responseId);
}

export function applyRunStepDelta({
  state,
  data,
  ctx,
  merge,
  editPrefixOffset,
  event,
}: TimingArgs<Agents.RunStepDeltaEvent> & { event: StepEvent }): void {
  const { submission } = ctx;
  const runStepDelta = data;
  const at = runStepDelta.observed_at;
  if (typeof at === 'number' && Number.isFinite(at) && at >= 0) {
    for (const chunk of runStepDelta.delta.tool_calls ?? []) {
      if (chunk.id) {
        const first =
          chunk.index === 0 ? state.firstFragmentByStep.get(runStepDelta.id) : undefined;
        const key = toolTimingKey(runStepDelta.id, chunk.id);
        state.firstFragmentByCall.set(
          key,
          Math.min(state.firstFragmentByCall.get(key) ?? at, first ?? at, at),
        );
        if (first != null) state.firstFragmentByStep.delete(runStepDelta.id);
      } else if (chunk.index === 0 && runStepDelta.delta.tool_calls?.length === 1) {
        const declared = state.steps.get(runStepDelta.id)?.stepDetails;
        const firstCallId =
          declared?.type === StepTypes.TOOL_CALLS && declared.tool_calls?.length === 1
            ? declared.tool_calls[0]?.id
            : undefined;
        if (firstCallId) {
          const key = toolTimingKey(runStepDelta.id, firstCallId);
          state.firstFragmentByCall.set(
            key,
            Math.min(state.firstFragmentByCall.get(key) ?? at, at),
          );
        } else {
          state.firstFragmentByStep.set(
            runStepDelta.id,
            Math.min(state.firstFragmentByStep.get(runStepDelta.id) ?? at, at),
          );
        }
      }
    }
  }
  const runStep = state.steps.get(runStepDelta.id);
  const responseMessageId = resolveResponseId(submission, runStep?.runId);
  if (!runStep || !responseMessageId) {
    bufferDelta(state, runStepDelta.id, event);
    return;
  }

  const response = state.messages.get(responseMessageId);
  const updatedResponse =
    response &&
    applyToolCallDelta(
      response,
      runStep,
      runStepDelta,
      state.toolCallIds.get(runStepDelta.id) ?? '',
      editPrefixOffset,
      (callId, index) => ({
        toolPreparationStartedAt:
          state.firstFragmentByCall.get(toolTimingKey(runStepDelta.id, callId)) ??
          (index === 0 ? state.firstFragmentByStep.get(runStepDelta.id) : undefined),
        toolDispatchedAt: state.dispatchedByCall.get(toolTimingKey(runStepDelta.id, callId)),
      }),
    );
  if (updatedResponse) {
    state.messages.set(responseMessageId, updatedResponse);
    merge(updatedResponse, responseMessageId);
  }
}

export function applyToolCallsDispatched({
  state,
  data,
  ctx,
  merge,
  editPrefixOffset,
}: TimingArgs<Agents.ToolCallsDispatchedEvent>): void {
  const { submission } = ctx;
  const { dispatched_at: at, toolCalls } = data;
  if (!isValidTime(at)) return;
  for (const call of toolCalls ?? []) {
    if (!call.id || !call.stepId) continue;
    const key = toolTimingKey(call.stepId, call.id);
    const dispatchedAt = Math.min(state.dispatchedByCall.get(key) ?? at, at);
    state.dispatchedByCall.set(key, dispatchedAt);
    const runStep = state.steps.get(call.stepId);
    if (!runStep?.runId) continue;
    const responseId = resolveResponseId(submission, runStep.runId);
    const response = state.messages.get(responseId);
    const index = runStep.index + editPrefixOffset;
    const part = response?.content?.[index];
    if (
      !response ||
      part?.type !== ContentTypes.TOOL_CALL ||
      part.tool_call.id !== call.id ||
      part.tool_call.runStepStatus != null
    ) {
      continue;
    }
    const content = [...(response.content ?? [])];
    content[index] = {
      ...part,
      tool_call: { ...part.tool_call, toolDispatchedAt: dispatchedAt },
    };
    const updated = { ...response, content };
    state.messages.set(responseId, updated);
    merge(updated, responseId);
  }
}

export function applyRunStepClosedTiming({
  state,
  data,
  ctx,
  merge,
  editPrefixOffset,
}: TimingArgs<Agents.RunStepClosedEvent>): void {
  const { submission } = ctx;
  const closed = data;
  const runStep = state.steps.get(closed.id);
  const responseMessageId = resolveResponseId(submission, runStep?.runId);
  /** A closure for a step this client never saw opened happens on reconnect, where the replay
   *  may start after the step was created; it is not an error worth surfacing. */
  if (!runStep || !responseMessageId) {
    return;
  }
  const response = state.messages.get(responseMessageId);
  const existing = response?.content?.[runStep.index + editPrefixOffset];
  if (!response || existing?.type !== ContentTypes.TOOL_CALL || !existing.tool_call) {
    return;
  }
  const existingToolCall = existing.tool_call;
  const key = toolTimingKey(closed.id, existingToolCall.id ?? '');
  const singleCallStep =
    runStep.stepDetails.type === StepTypes.TOOL_CALLS &&
    (runStep.stepDetails.tool_calls?.length ?? 0) <= 1;
  const observedAt = Math.min(
    state.firstFragmentByCall.get(key) ?? Infinity,
    existingToolCall.toolPreparationStartedAt ?? Infinity,
    singleCallStep ? (state.firstFragmentByStep.get(closed.id) ?? Infinity) : Infinity,
  );
  const timing = getToolTimingDurations({
    observedAt: Number.isFinite(observedAt) ? observedAt : undefined,
    dispatchedAt: existingToolCall.toolDispatchedAt ?? state.dispatchedByCall.get(key),
    completedAt: state.completedByCall.get(key),
  });
  state.firstFragmentByCall.delete(key);
  state.firstFragmentByStep.delete(closed.id);
  state.dispatchedByCall.delete(key);
  state.completedByCall.delete(key);
  const updatedResponse = applyRunStepClosed(response, runStep, closed, editPrefixOffset, timing);
  if (updatedResponse) {
    state.messages.set(responseMessageId, updatedResponse);
    merge(updatedResponse, responseMessageId);
  }
}

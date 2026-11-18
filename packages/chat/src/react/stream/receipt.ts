import { atom } from 'jotai';
import { StepEvents, StepTypes } from 'librechat-data-provider';
import type { PrimitiveAtom } from 'jotai';
import type { StepEvent, StreamState } from '../../core';
import { toolTimingKey } from '../../core/stream/state';

/** Browser receipt times are transient and never persisted with server timing metadata. */
export const phaseReceipts: PrimitiveAtom<ReadonlyMap<string, ReadonlyMap<number, number>>> = atom<
  ReadonlyMap<string, ReadonlyMap<number, number>>
>(new Map());

export function visitPhaseStamps(
  event: StepEvent,
  state: StreamState,
  visit: (stepId: string, stamp: number) => void,
): void {
  const record = (stepId: string, stamp: number | undefined, first?: number) => {
    if (
      stepId &&
      stamp != null &&
      Number.isFinite(stamp) &&
      stamp >= 0 &&
      (first == null || stamp <= first)
    ) {
      visit(stepId, stamp);
    }
  };
  if (event.event === StepEvents.ON_TOOL_CALLS_DISPATCHED) {
    for (const call of event.data.toolCalls ?? []) {
      if (!call.stepId || !call.id) continue;
      record(
        call.stepId,
        event.data.dispatched_at,
        state.dispatchedByCall.get(toolTimingKey(call.stepId, call.id)),
      );
    }
    return;
  }
  if (
    event.event !== StepEvents.ON_TOOL_PREPARATION &&
    event.event !== StepEvents.ON_RUN_STEP_DELTA
  )
    return;
  const { id, observed_at: stamp } = event.data;
  const details = state.steps.get(id)?.stepDetails;
  const declared = details?.type === StepTypes.TOOL_CALLS ? details.tool_calls : undefined;
  const calls =
    event.event === StepEvents.ON_TOOL_PREPARATION
      ? [{ id: event.data.toolCallId, index: event.data.index }]
      : (event.data.delta.tool_calls ?? []);
  for (const call of calls) {
    const callId =
      call.id ?? (call.index === 0 && declared?.length === 1 ? declared[0]?.id : undefined);
    const first = callId
      ? state.firstFragmentByCall.get(toolTimingKey(id, callId))
      : state.firstFragmentByStep.get(id);
    record(id, stamp, first);
  }
}

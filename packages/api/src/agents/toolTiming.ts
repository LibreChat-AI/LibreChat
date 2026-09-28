import { getToolTimingDurations } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';

/** A dispatch is an SDK handoff, not proof of host, MCP, or database execution. */
type DispatchedCall = { id: string; stepId?: string };
type Dispatch = { dispatched_at: number; toolCalls: DispatchedCall[] };
type Fragment = Pick<Agents.RunStepDeltaEvent, 'id' | 'delta' | 'observed_at'>;

export type ToolTimingTracker = {
  observe(fragment: Fragment): void;
  dispatched(event: Dispatch): void;
  completed(id: string, at?: number): void;
  take(callId: string, stepId: string): ReturnType<typeof getToolTimingDurations>;
};

const validTime = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** One instance per response. No prompt, argument, or result data is retained. */
export function createToolTimingTracker(): ToolTimingTracker {
  const firstByCall = new Map<string, number>();
  const firstByStep = new Map<string, number>();
  const firstCallByStep = new Map<string, string>();
  const callIdsByStep = new Map<string, Set<string>>();
  const dispatchedByCall = new Map<string, number>();
  const completedByCall = new Map<string, number>();

  return {
    observe({ id, delta, observed_at: at }: Fragment): void {
      if (!validTime(at) || delta.type !== 'tool_calls') return;
      for (const chunk of delta.tool_calls ?? []) {
        if (chunk.id) {
          const first = chunk.index === 0 ? firstByStep.get(id) : undefined;
          firstByCall.set(chunk.id, Math.min(firstByCall.get(chunk.id) ?? at, first ?? at, at));
          if (chunk.index === 0) {
            firstCallByStep.set(id, chunk.id);
            firstByStep.delete(id);
          }
        } else if (id && delta.tool_calls?.length === 1 && chunk.index === 0) {
          const firstCallId = firstCallByStep.get(id);
          if (firstCallId) {
            firstByCall.set(firstCallId, Math.min(firstByCall.get(firstCallId) ?? at, at));
          } else {
            firstByStep.set(id, Math.min(firstByStep.get(id) ?? at, at));
          }
        }
      }
    },
    dispatched({ dispatched_at: at, toolCalls }: Dispatch): void {
      if (!validTime(at) || !Array.isArray(toolCalls)) return;
      for (const call of toolCalls) {
        if (!call.id) continue;
        dispatchedByCall.set(call.id, Math.min(dispatchedByCall.get(call.id) ?? at, at));
        if (call.stepId) {
          const ids = callIdsByStep.get(call.stepId) ?? new Set<string>();
          ids.add(call.id);
          callIdsByStep.set(call.stepId, ids);
        }
      }
    },
    completed(id: string, at?: number): void {
      if (id && validTime(at)) completedByCall.set(id, at);
    },
    take(callId: string, stepId: string): ReturnType<typeof getToolTimingDurations> {
      const ownedIds = callIdsByStep.get(stepId);
      const soleCall = ownedIds?.size === 1 && ownedIds.has(callId);
      const start = Math.min(
        firstByCall.get(callId) ?? Infinity,
        soleCall ? (firstByStep.get(stepId) ?? Infinity) : Infinity,
      );
      const dispatchedAt = dispatchedByCall.get(callId);
      const completedAt = completedByCall.get(callId);
      firstByCall.delete(callId);
      firstByStep.delete(stepId);
      firstCallByStep.delete(stepId);
      callIdsByStep.delete(stepId);
      dispatchedByCall.delete(callId);
      completedByCall.delete(callId);
      return getToolTimingDurations({
        observedAt: Number.isFinite(start) ? start : undefined,
        dispatchedAt,
        completedAt,
      });
    },
  };
}

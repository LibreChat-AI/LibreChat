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
  const dispatchedByCall = new Map<string, number>();
  const completedByCall = new Map<string, number>();

  return {
    observe({ id, delta, observed_at: at }: Fragment): void {
      if (!validTime(at) || delta.type !== 'tool_calls') return;
      for (const chunk of delta.tool_calls ?? []) {
        if (chunk.id) {
          firstByCall.set(chunk.id, Math.min(firstByCall.get(chunk.id) ?? at, at));
        } else if (id && delta.tool_calls?.length === 1 && chunk.index === 0) {
          firstByStep.set(id, Math.min(firstByStep.get(id) ?? at, at));
        }
      }
    },
    dispatched({ dispatched_at: at, toolCalls }: Dispatch): void {
      if (!validTime(at) || !Array.isArray(toolCalls)) return;
      for (const call of toolCalls) {
        if (!call.id) continue;
        dispatchedByCall.set(call.id, Math.min(dispatchedByCall.get(call.id) ?? at, at));
      }
    },
    completed(id: string, at?: number): void {
      if (id && validTime(at)) completedByCall.set(id, at);
    },
    take(callId: string, stepId: string): ReturnType<typeof getToolTimingDurations> {
      const start = firstByCall.get(callId) ?? firstByStep.get(stepId);
      const dispatchedAt = dispatchedByCall.get(callId);
      const completedAt = completedByCall.get(callId);
      firstByCall.delete(callId);
      firstByStep.delete(stepId);
      dispatchedByCall.delete(callId);
      completedByCall.delete(callId);
      return getToolTimingDurations({ observedAt: start, dispatchedAt, completedAt });
    },
  };
}

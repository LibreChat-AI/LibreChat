import { StepEvents, getToolTimingDurations } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';

/** SDK handoff, not proof that the host or database started executing. */
type DispatchedCall = { id: string; stepId?: string };
type Dispatch = { dispatched_at: number; toolCalls: DispatchedCall[] };
type Fragment = Pick<Agents.RunStepDeltaEvent, 'id' | 'delta' | 'observed_at'>;
export type ToolPreparationMarker = Agents.ToolPreparationMarker;
type StepTiming = {
  firstByCall: Map<string, number>;
  firstUnidentified?: number;
  firstCallId?: string;
  dispatchedByCall: Map<string, number>;
  completedByCall: Map<string, number>;
  pendingIds: Set<string>;
};

export type ToolTimingTracker = {
  observe(fragment: Fragment): ToolPreparationMarker[];
  prepare(marker: ToolPreparationMarker): void;
  dispatched(event: Dispatch): void;
  completed(stepId: string, callId: string, at?: number): void;
  take(callId: string, stepId: string): ReturnType<typeof getToolTimingDurations>;
};

const validTime = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** One instance per response. Only bounded IDs and timestamps are retained. */
type TimingEvent =
  | { event: StepEvents.ON_TOOL_PREPARATION; data: ToolPreparationMarker }
  | { event: StepEvents.ON_TOOL_CALLS_DISPATCHED; data: Agents.ToolCallsDispatchedEvent };

type ToolCompletion = {
  result?: { id?: string; completed_at?: number; tool_call?: { id?: string } };
};

type ChildTimingStamps = { observedAt?: number; dispatchedAt?: number };

type ChildTimingAggregator = {
  stepMap?: Map<string, { index: number }>;
  contentParts?: Array<{
    type?: string;
    tool_call?: {
      id?: string;
      toolPreparationStartedAt?: number;
      toolDispatchedAt?: number;
      toolPreparationDurationMs?: number;
      toolExecutionDurationMs?: number;
    };
  }>;
};

export type ToolTimingAdapter = {
  dispatch: { handle(event: string, data: Agents.ToolCallsDispatchedEvent): Promise<void> };
  delta(fragment: Fragment): Promise<void>;
  completed(event: ToolCompletion): void;
  close(toolCall: { id?: string }, stepId: string): void;
  child(aggregator: ChildTimingAggregator, update: { phase?: string; data?: unknown }): void;
};

/** Owns timing event transitions; legacy Express only wires these handlers. */
export function createToolTimingAdapter({
  replayEvents,
  emit,
}: {
  replayEvents?: readonly { event: string; data?: unknown }[];
  emit(event: TimingEvent): Promise<void> | void;
}): ToolTimingAdapter {
  const tracker = createToolTimingTracker(replayEvents);
  const childStamps = new WeakMap<ChildTimingAggregator, Map<string, ChildTimingStamps>>();
  return {
    dispatch: {
      async handle(_event, data) {
        tracker.dispatched(data);
        await emit({ event: StepEvents.ON_TOOL_CALLS_DISPATCHED, data });
      },
    },
    async delta(fragment) {
      for (const marker of tracker.observe(fragment)) {
        await emit({ event: StepEvents.ON_TOOL_PREPARATION, data: marker });
      }
    },
    completed(event) {
      const result = event?.result;
      if (result?.id && result.tool_call?.id) {
        tracker.completed(result.id, result.tool_call.id, result.completed_at);
      }
    },
    close(toolCall, stepId) {
      Object.assign(toolCall, tracker.take(toolCall.id ?? '', stepId));
    },
    child(aggregator, update) {
      let stamps = childStamps.get(aggregator);
      if (!stamps) {
        stamps = new Map();
        childStamps.set(aggregator, stamps);
      }
      applySubagentToolTiming(aggregator, update, stamps);
    },
  };
}

function applySubagentToolTiming(
  aggregator: ChildTimingAggregator,
  update: { phase?: string; data?: unknown },
  stamps: Map<string, ChildTimingStamps>,
): void {
  if (
    update.phase !== 'tool_preparation' &&
    update.phase !== 'tool_calls_dispatched' &&
    update.phase !== 'run_step_completed'
  )
    return;
  if (update.data == null || typeof update.data !== 'object') return;
  const data = update.data as {
    id?: string;
    toolCallId?: string;
    observed_at?: number;
    dispatched_at?: number;
    toolCalls?: Array<{ id?: string; stepId?: string }>;
    result?: { id?: string; completed_at?: number; tool_call?: { id?: string } };
  };
  const apply = (
    stepId: string | undefined,
    callId: string | undefined,
    fn: (tool: {
      id?: string;
      toolPreparationStartedAt?: number;
      toolDispatchedAt?: number;
      toolPreparationDurationMs?: number;
      toolExecutionDurationMs?: number;
    }) => void,
  ) => {
    if (!stepId || !callId) return;
    const index = aggregator.stepMap?.get(stepId)?.index;
    const part = index == null ? undefined : aggregator.contentParts?.[index];
    if (part?.type !== 'tool_call' || part.tool_call?.id !== callId) return;
    fn(part.tool_call);
  };
  if (update.phase === 'tool_preparation' && validTime(data.observed_at)) {
    if (!data.id || !data.toolCallId) return;
    const key = `${data.id}\u0000${data.toolCallId}`;
    const previous = stamps.get(key) ?? {};
    const observedAt = Math.min(previous.observedAt ?? data.observed_at, data.observed_at);
    stamps.set(key, { ...previous, observedAt });
    apply(data.id, data.toolCallId, (tool) => {
      tool.toolPreparationStartedAt = observedAt;
    });
  }
  if (update.phase === 'tool_calls_dispatched' && validTime(data.dispatched_at)) {
    for (const call of data.toolCalls ?? []) {
      if (!call.stepId || !call.id) continue;
      const key = `${call.stepId}\u0000${call.id}`;
      const previous = stamps.get(key) ?? {};
      const dispatchedAt = Math.min(
        previous.dispatchedAt ?? data.dispatched_at!,
        data.dispatched_at!,
      );
      stamps.set(key, { ...previous, dispatchedAt });
      apply(call.stepId, call.id, (tool) => {
        tool.toolDispatchedAt = dispatchedAt;
        if (previous.observedAt != null) tool.toolPreparationStartedAt = previous.observedAt;
      });
    }
  }
  if (update.phase === 'run_step_completed' && validTime(data.result?.completed_at)) {
    const stepId = data.result?.id;
    const callId = data.result?.tool_call?.id;
    if (!stepId || !callId) return;
    const key = `${stepId}\u0000${callId}`;
    const recorded = stamps.get(key);
    apply(stepId, callId, (tool) => {
      if (recorded?.dispatchedAt != null) tool.toolDispatchedAt = recorded.dispatchedAt;
      if (recorded?.observedAt != null) tool.toolPreparationStartedAt = recorded.observedAt;
      Object.assign(
        tool,
        getToolTimingDurations({
          observedAt: tool.toolPreparationStartedAt,
          dispatchedAt: tool.toolDispatchedAt,
          completedAt: data.result?.completed_at,
        }),
      );
    });
    stamps.delete(key);
  }
}

export function createToolTimingTracker(
  replayEvents: readonly { event: string; data?: unknown }[] = [],
): ToolTimingTracker {
  const steps = new Map<string, StepTiming>();
  const getStep = (id: string): StepTiming => {
    let step = steps.get(id);
    if (!step) {
      step = {
        firstByCall: new Map(),
        dispatchedByCall: new Map(),
        completedByCall: new Map(),
        pendingIds: new Set(),
      };
      steps.set(id, step);
    }
    return step;
  };
  const prepare = ({ id, index, toolCallId, observed_at: at }: ToolPreparationMarker): void => {
    if (!id || !validTime(at)) return;
    const step = getStep(id);
    if (toolCallId) {
      step.firstByCall.set(toolCallId, Math.min(step.firstByCall.get(toolCallId) ?? at, at));
      if (index === 0) step.firstCallId = toolCallId;
    } else if (index === 0) {
      step.firstUnidentified = Math.min(step.firstUnidentified ?? at, at);
      if (step.firstCallId) {
        const first = step.firstCallId;
        step.firstByCall.set(first, Math.min(step.firstByCall.get(first) ?? at, at));
      }
    }
  };

  const tracker: ToolTimingTracker = {
    observe({ id, delta, observed_at: at }: Fragment): ToolPreparationMarker[] {
      if (!id || !validTime(at) || delta.type !== 'tool_calls') return [];
      const markers: ToolPreparationMarker[] = [];
      const step = getStep(id);
      for (const chunk of delta.tool_calls ?? []) {
        const index = typeof chunk.index === 'number' ? chunk.index : undefined;
        const callId = typeof chunk.id === 'string' && chunk.id ? chunk.id : undefined;
        if (!callId && (index !== 0 || delta.tool_calls?.length !== 1)) continue;
        const prior = callId ? step.firstByCall.get(callId) : step.firstUnidentified;
        const marker = { id, index, ...(callId && { toolCallId: callId }), observed_at: at };
        prepare(marker);
        if (prior == null) markers.push(marker);
      }
      return markers;
    },
    prepare,
    dispatched({ dispatched_at: at, toolCalls }: Dispatch): void {
      if (!validTime(at) || !Array.isArray(toolCalls)) return;
      for (const call of toolCalls) {
        if (!call.id || !call.stepId) continue;
        const step = getStep(call.stepId);
        step.pendingIds.add(call.id);
        step.dispatchedByCall.set(call.id, Math.min(step.dispatchedByCall.get(call.id) ?? at, at));
      }
    },
    completed(stepId: string, callId: string, at?: number): void {
      if (stepId && callId && validTime(at)) getStep(stepId).completedByCall.set(callId, at);
    },
    take(callId: string, stepId: string): ReturnType<typeof getToolTimingDurations> {
      const step = steps.get(stepId);
      if (!step) return {};
      const sole = step.pendingIds.size === 1 && step.pendingIds.has(callId);
      const unidentified =
        step.firstCallId === callId || (step.firstCallId == null && sole)
          ? step.firstUnidentified
          : undefined;
      const start = Math.min(step.firstByCall.get(callId) ?? Infinity, unidentified ?? Infinity);
      const duration = getToolTimingDurations({
        observedAt: Number.isFinite(start) ? start : undefined,
        dispatchedAt: step.dispatchedByCall.get(callId),
        completedAt: step.completedByCall.get(callId),
      });
      step.firstByCall.delete(callId);
      step.dispatchedByCall.delete(callId);
      step.completedByCall.delete(callId);
      step.pendingIds.delete(callId);
      if (step.pendingIds.size === 0) steps.delete(stepId);
      return duration;
    },
  };
  for (const event of replayEvents) {
    if (event.data == null || typeof event.data !== 'object') continue;
    if (event.event === StepEvents.ON_TOOL_PREPARATION) {
      const marker = event.data as Partial<ToolPreparationMarker>;
      if (typeof marker.id === 'string' && typeof marker.observed_at === 'number') {
        tracker.prepare(marker as ToolPreparationMarker);
      }
    } else if (event.event === StepEvents.ON_TOOL_CALLS_DISPATCHED) {
      tracker.dispatched(event.data as Dispatch);
    }
  }
  return tracker;
}

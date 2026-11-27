import { GraphEvents } from '@librechat/agents';
import { ContentTypes } from 'librechat-data-provider';
import type { Agents, TSteerAppliedEvent } from 'librechat-data-provider';
import type { createContentAggregator } from '@librechat/agents';
import type { SubagentActivityUpdateEvent } from './subagentActivity';
import type { ToolTimingAdapter } from './toolTiming';

type SubagentAggregator = ReturnType<typeof createContentAggregator>;
type AggregateInput = Parameters<SubagentAggregator['aggregateContent']>[0];

function subagentPhaseToGraphEvent(event: SubagentActivityUpdateEvent): GraphEvents | null {
  switch (event?.phase) {
    case 'run_step':
      // Tool-execute batch requests share this phase but are not run steps.
      return (event.data as Agents.RunStep | undefined)?.stepDetails
        ? GraphEvents.ON_RUN_STEP
        : null;
    case 'run_step_delta':
      return GraphEvents.ON_RUN_STEP_DELTA;
    case 'run_step_completed':
      return GraphEvents.ON_RUN_STEP_COMPLETED;
    case 'message_delta':
      return GraphEvents.ON_MESSAGE_DELTA;
    case 'reasoning_delta':
      return GraphEvents.ON_REASONING_DELTA;
    default:
      return null;
  }
}

/** Consume already-public child updates; host indices already include steering offsets. */
export function feedSubagentAggregator(
  aggregator: SubagentAggregator,
  event: SubagentActivityUpdateEvent,
  applyChildTiming: ToolTimingAdapter['child'],
): void {
  if (event.phase === 'steer_applied') {
    const data = event.data as TSteerAppliedEvent | undefined;
    if (
      data != null &&
      Number.isSafeInteger(data.index) &&
      data.index >= 0 &&
      data.part?.type === ContentTypes.STEER
    ) {
      // Seed, do not splice: the SDK observes this slot on its next allocation.
      aggregator.contentParts[data.index] = data.part;
    }
  }
  const graphEvent = subagentPhaseToGraphEvent(event);
  if (graphEvent) {
    aggregator.aggregateContent({ event: graphEvent, data: event.data as AggregateInput['data'] });
  }
  applyChildTiming(aggregator, event);
  if (!graphEvent) return;

  // Restore host routing metadata omitted by the SDK's public tool projection.
  const data = event.data as Agents.RunStep | undefined;
  const toolCalls =
    data?.stepDetails?.type === 'tool_calls' ? (data.stepDetails.tool_calls ?? []) : [];
  const stepIndex = aggregator.stepMap.get(data?.id ?? '')?.index;
  if (stepIndex == null || !Number.isInteger(stepIndex)) return;
  for (let index = 0; index < toolCalls.length; index++) {
    const source = toolCalls[index];
    const part = aggregator.contentParts[stepIndex + index];
    const target = part && 'tool_call' in part ? part.tool_call : undefined;
    if (
      target?.id === source?.id &&
      'mcpServerName' in source &&
      typeof source.mcpServerName === 'string'
    ) {
      target.mcpServerName = source.mcpServerName;
    }
  }
}

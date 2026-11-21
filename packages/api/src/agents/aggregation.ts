import { GraphEvents } from '@librechat/agents';
import { Constants, ContentTypes } from 'librechat-data-provider';
import type {
  Agents,
  SubagentIdentity,
  TSteerAppliedEvent,
  TMessageContentParts,
} from 'librechat-data-provider';
import type { createContentAggregator } from '@librechat/agents';
import type { SubagentActivityUpdateEvent } from './subagentActivity';
import type { ToolTimingAdapter } from './toolTiming';

type SubagentAggregator = ReturnType<typeof createContentAggregator>;
type AggregateInput = Parameters<SubagentAggregator['aggregateContent']>[0];

/** What a run buffered for one child: its content, and who it ran as once an update said so. */
export type SubagentBuffer = Pick<SubagentAggregator, 'contentParts'> & {
  subagentIdentity?: SubagentIdentity;
};

type SubagentCall = {
  id?: string;
  name?: string;
  subagentIdentity?: SubagentIdentity;
  subagent_content?: TMessageContentParts[];
};

/**
 * Moves each buffered child onto the `subagent` call that started it, as `subagentIdentity` and
 * `subagent_content`, so a reload shows who ran and what they did. A child's own content can hold
 * calls of its own, so each attached transcript is searched in turn: a call made from inside a
 * subagent keeps its child the same way a call in the reply does. A buffer is attached once and
 * the rest, whose call never appeared, is dropped.
 */
export function attachSubagentContent(
  content: readonly (TMessageContentParts | undefined)[] | undefined,
  buffers: Map<string, SubagentBuffer> | undefined,
  onError?: (toolCallId: string, error: unknown) => void,
): void {
  if (buffers == null || buffers.size === 0 || !Array.isArray(content)) {
    return;
  }
  const pending: (readonly (TMessageContentParts | undefined)[])[] = [content];
  for (let index = 0; index < pending.length && buffers.size > 0; index++) {
    for (const part of pending[index]) {
      if (part?.type !== ContentTypes.TOOL_CALL) {
        continue;
      }
      const call = part[ContentTypes.TOOL_CALL] as SubagentCall | undefined;
      if (call?.name !== Constants.SUBAGENT || !call.id) {
        continue;
      }
      const buffer = buffers.get(call.id);
      if (buffer == null) {
        continue;
      }
      buffers.delete(call.id);
      try {
        if (buffer.subagentIdentity != null) {
          call.subagentIdentity = buffer.subagentIdentity;
        }
        /** The aggregator's array is sparse: slots that never received content are holes. */
        const parts = Array.isArray(buffer.contentParts)
          ? (buffer.contentParts.filter((entry) => entry != null) as TMessageContentParts[])
          : [];
        if (parts.length > 0) {
          call.subagent_content = parts;
          pending.push(parts);
        }
      } catch (error) {
        onError?.(call.id, error);
      }
    }
  }
  buffers.clear();
}

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

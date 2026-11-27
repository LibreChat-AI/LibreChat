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

/** The skill each `skill` call of a run loaded, by tool call id, as the execute handler recorded it. */
type SkillCalls = ReadonlyMap<string, { stepId?: string; skillId: string }>;
type SkillTarget = { id?: string; skillId?: string };

/** The aggregated call `id`: its step's slot when that holds it, otherwise whichever slot it
 *  landed in, since a step carrying several calls keeps the rest after its first. */
function findCall(
  parts: readonly unknown[] | null | undefined,
  index: number | undefined,
  id: string,
): SkillTarget | undefined {
  const at = (slot: number) =>
    (parts?.[slot] as { tool_call?: SkillTarget } | null | undefined)?.tool_call;
  if (index != null && at(index)?.id === id) {
    return at(index);
  }
  for (let slot = 0; slot < (parts?.length ?? 0); slot++) {
    if (at(slot)?.id === id) {
      return at(slot);
    }
  }
  return undefined;
}

/**
 * Stamps the skill a completed `skill` call loaded on the completion event's tool call (streamed)
 * and on its aggregated part (persisted): the SDK's aggregator rebuilds the part from the fields it
 * knows, so the part needs its own copy. Records stay for the run, since every completion of a
 * step rebuilds its part. A call the handler did not record, or a record from another step, is
 * left untouched.
 */
export function stampSkillId(
  skillCalls: SkillCalls | null | undefined,
  result: { id?: unknown; tool_call?: SkillTarget } | null | undefined,
  parts?: readonly unknown[] | null,
  index?: number,
): void {
  const call = result?.tool_call;
  const record = call?.id == null ? undefined : skillCalls?.get(call.id);
  if (call?.id == null || record == null) {
    return;
  }
  if (record.stepId != null && record.stepId !== result?.id) {
    return;
  }
  call.skillId = record.skillId;
  const part = findCall(parts, index, call.id);
  if (part != null) {
    part.skillId = record.skillId;
  }
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

/**
 * Consume already-public child updates; host indices already include steering offsets. A child's
 * completed `skill` call gets the id its handler recorded in the run's `skillCalls`, on the update
 * sent on and on the buffered part.
 */
export function feedSubagentAggregator(
  aggregator: SubagentAggregator,
  event: SubagentActivityUpdateEvent,
  applyChildTiming: ToolTimingAdapter['child'],
  run?: { skillCalls?: SkillCalls } | null,
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

  if (graphEvent === GraphEvents.ON_RUN_STEP_COMPLETED) {
    const result = (event.data as { result?: Agents.ToolEndEvent } | undefined)?.result;
    const index = aggregator.stepMap.get(result?.id ?? '')?.index;
    stampSkillId(run?.skillCalls, result, aggregator.contentParts, index);
    return;
  }

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

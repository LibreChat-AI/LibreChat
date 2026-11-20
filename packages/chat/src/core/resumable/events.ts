import { Constants, StepEvents } from 'librechat-data-provider';
import type { TSubmission } from 'librechat-data-provider';
import type { ResumableUsage } from './host';
import type { StepEvent } from '../reducer';

const getToolCallName = (toolCall: unknown): unknown =>
  toolCall != null && typeof toolCall === 'object' && 'name' in toolCall
    ? (toolCall.name as unknown)
    : undefined;

const isOAuthToolCallName = (name: unknown): boolean =>
  typeof name === 'string' && name.startsWith(`oauth${Constants.mcp_delimiter}`);

const hasOAuthToolCall = (toolCalls: unknown): boolean =>
  Array.isArray(toolCalls) &&
  toolCalls.some((toolCall) => isOAuthToolCallName(getToolCallName(toolCall)));

export const isOAuthStepEvent = (data: unknown): boolean => {
  if (data == null || typeof data !== 'object' || !('event' in data)) {
    return false;
  }

  const event = data.event;
  const payload = 'data' in data ? data.data : undefined;
  if (payload == null || typeof payload !== 'object') {
    return false;
  }

  if (event === StepEvents.ON_RUN_STEP) {
    const stepDetails = 'stepDetails' in payload ? payload.stepDetails : undefined;
    return (
      stepDetails != null &&
      typeof stepDetails === 'object' &&
      'tool_calls' in stepDetails &&
      hasOAuthToolCall(stepDetails.tool_calls)
    );
  }

  if (event === StepEvents.ON_RUN_STEP_DELTA) {
    const delta = 'delta' in payload ? payload.delta : undefined;
    if (delta == null || typeof delta !== 'object') {
      return false;
    }
    return (
      ('auth' in delta && delta.auth != null) ||
      ('tool_calls' in delta && hasOAuthToolCall(delta.tool_calls))
    );
  }

  if (event === StepEvents.ON_RUN_STEP_COMPLETED) {
    const result = 'result' in payload ? payload.result : undefined;
    if (result == null || typeof result !== 'object' || !('tool_call' in result)) {
      return false;
    }
    return isOAuthToolCallName(getToolCallName(result.tool_call));
  }

  return false;
};

export const getStepEventId = (event: unknown): string | undefined => {
  if (event == null || typeof event !== 'object' || !('data' in event)) {
    return undefined;
  }
  const data = event.data;
  if (data == null || typeof data !== 'object') {
    return undefined;
  }
  if ('id' in data && typeof data.id === 'string') {
    return data.id;
  }
  const result = 'result' in data ? data.result : undefined;
  return result != null &&
    typeof result === 'object' &&
    'id' in result &&
    typeof result.id === 'string'
    ? result.id
    : undefined;
};

/**
 * Tells the usage writers the id a run step gives the turn's reply. The reply is drawn under a
 * placeholder id until then, and usage is bound to the submission that still names the
 * placeholder; without this the reply being written stops counting as the one in progress the
 * moment its row is renamed, and what a reader sees of its usage stands still until it ends.
 */
export function nameStepResponse(
  usage: Pick<ResumableUsage, 'nameResponse'> | undefined,
  event: StepEvent,
  submission: TSubmission,
): void {
  if (event.event !== StepEvents.ON_RUN_STEP) {
    return;
  }
  const { runId } = event.data;
  if (!runId || runId === Constants.USE_PRELIM_RESPONSE_MESSAGE_ID) {
    return;
  }
  usage?.nameResponse?.(runId, submission);
}

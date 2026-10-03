import {
  StepTypes,
  ContentTypes,
  getRunStepDurationMs,
  getRunStepCloseMetadata,
} from 'librechat-data-provider';
import type { Agents, TMessage, PartMetadata } from 'librechat-data-provider';
import { getStepMetadata, updateContent } from './content';

type ToolTimingLookup = (
  callId: string,
  index?: number,
) => Pick<PartMetadata, 'toolPreparationStartedAt' | 'toolDispatchedAt'>;

/** Mirrors `SKILL_FILE_PREFIX` in `@librechat/api` file-authoring handlers. */
const SKILL_FILE_PREFIX = 'skills/';
const FILE_AUTHORING_TOOLS = new Set(['create_file', 'edit_file']);

/**
 * True when a completed tool call authored a skill file (`create_file` /
 * `edit_file` targeting a `skills/...` path). Skills created or edited
 * mid-chat must invalidate the cached skill queries, or the Skills panel
 * and builder keep showing the pre-authoring catalog.
 */
export function isSkillAuthoringToolCall(toolCall?: Agents.ToolCall): boolean {
  if (!toolCall?.name || !FILE_AUTHORING_TOOLS.has(toolCall.name)) {
    return false;
  }
  const { args } = toolCall;
  let filePath: unknown;
  if (typeof args === 'object' && args !== null) {
    filePath = (args as { file_path?: unknown }).file_path;
  } else if (typeof args === 'string') {
    try {
      filePath = (JSON.parse(args) as { file_path?: unknown }).file_path;
    } catch {
      return false;
    }
  }
  return typeof filePath === 'string' && filePath.startsWith(SKILL_FILE_PREFIX);
}

/** True when the slot already holds this call settled: an output or full progress. */
const isSettledToolCall = (message: TMessage, index: number, id: string): boolean => {
  const part = message.content?.[index];
  if (!id || part?.type !== ContentTypes.TOOL_CALL) {
    return false;
  }
  const toolCall = part[ContentTypes.TOOL_CALL] as (Agents.ToolCall & PartMetadata) | undefined;
  return toolCall?.id === id && (toolCall.output != null || toolCall.progress === 1);
};

/**
 * Opens the tool-call parts a `tool_calls` run step announces, all at the step's slot.
 * AI SDK: `tool-input-start`.
 *
 * A step announced again after its call settled, as the resume path does for every known run
 * step, leaves the settled part alone: reopening it would drop its output and completion fields.
 *
 * Returns the next message and the tool-call id to record for the step, so later argument deltas,
 * which carry only the step id, can be attributed. The last non-empty id wins, matching a step
 * that announces a single call.
 */
export function applyToolCallsStep(
  message: TMessage,
  runStep: Agents.RunStep,
  editPrefixOffset: number,
  getTiming?: ToolTimingLookup,
): { message: TMessage; toolCallId?: string } {
  if (runStep.stepDetails.type !== StepTypes.TOOL_CALLS) {
    return { message };
  }
  const index = runStep.index + editPrefixOffset;
  const metadata = getStepMetadata(runStep);
  let next: TMessage = { ...message };
  let toolCallId: string | undefined;
  for (const toolCall of (runStep.stepDetails.tool_calls ?? []) as Agents.ToolCall[]) {
    const id = toolCall.id ?? '';
    if ('id' in toolCall && id) {
      toolCallId = id;
    }
    if (isSettledToolCall(next, index, id)) {
      continue;
    }
    next = updateContent(
      next,
      index,
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          name: toolCall.name ?? '',
          args: toolCall.args,
          execution: toolCall.execution,
          id,
          stepId: runStep.id,
          ...getTiming?.(id),
        },
      },
      false,
      metadata,
    );
  }
  return { message: next, toolCallId };
}

/**
 * Appends streamed tool-call arguments (and any OAuth prompt) to the step's tool-call part.
 * AI SDK: `tool-input-delta`. Returns `undefined` for a delta that is not a tool-call delta.
 */
export function applyToolCallDelta(
  message: TMessage,
  runStep: Agents.RunStep,
  delta: Agents.RunStepDeltaEvent,
  toolCallId: string,
  editPrefixOffset: number,
  getTiming?: ToolTimingLookup,
): TMessage | undefined {
  if (delta.delta.type !== StepTypes.TOOL_CALLS || !delta.delta.tool_calls) {
    return undefined;
  }
  const index = runStep.index + editPrefixOffset;
  const metadata = getStepMetadata(runStep);
  let next: TMessage = { ...message };
  for (const toolCallDelta of delta.delta.tool_calls) {
    const id = toolCallDelta.id || toolCallId;
    const contentPart: Agents.MessageContentComplex = {
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        name: toolCallDelta.name ?? '',
        args: toolCallDelta.args ?? '',
        id,
        stepId: delta.id,
        ...getTiming?.(id, toolCallDelta.index),
      },
    };
    if (delta.delta.auth != null) {
      contentPart.tool_call.auth = delta.delta.auth;
      contentPart.tool_call.expires_at = delta.delta.expires_at;
    }
    next = updateContent(next, index, contentPart, false, metadata);
  }
  return next;
}

/**
 * Settles the step's tool-call part with its output, marking it complete.
 * AI SDK: `tool-output-available`.
 */
export function applyToolCallCompleted(
  message: TMessage,
  runStep: Agents.RunStep,
  result: Agents.ToolEndEvent,
  editPrefixOffset: number,
): TMessage {
  return updateContent(
    { ...message },
    runStep.index + editPrefixOffset,
    { type: ContentTypes.TOOL_CALL, tool_call: { ...result.tool_call, stepId: result.id } },
    true,
    getStepMetadata(runStep),
  );
}

/**
 * Stamps a closed step's terminal status and duration on its tool-call part. Only tool calls
 * render a running state, so any other part type (or an empty slot, as on a reconnect that
 * missed the opening) returns `undefined` and is left alone.
 */
export function applyRunStepClosed(
  message: TMessage,
  runStep: Agents.RunStep,
  closed: Agents.RunStepClosedEvent,
  editPrefixOffset: number,
  timing: Pick<PartMetadata, 'toolPreparationDurationMs' | 'toolExecutionDurationMs'> = {},
): TMessage | undefined {
  const index = runStep.index + editPrefixOffset;
  const existing = message.content?.[index];
  if (!existing || existing.type !== ContentTypes.TOOL_CALL) {
    return undefined;
  }
  const existingToolCall = existing[ContentTypes.TOOL_CALL];
  if (!existingToolCall) {
    return undefined;
  }
  /** Spread conditionally so an unknowable duration leaves any value the server already stamped
   *  in place, rather than overwriting it with `undefined`. */
  const durationMs = getRunStepDurationMs(closed);
  const content = [...(message.content ?? [])];
  content[index] = {
    ...existing,
    [ContentTypes.TOOL_CALL]: {
      ...existingToolCall,
      runStepStatus: closed.status,
      ...getRunStepCloseMetadata(closed),
      ...(durationMs != null && { runStepDurationMs: durationMs }),
      ...timing,
    },
  };
  return { ...message, content };
}

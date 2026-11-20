import { StepTypes, StepEvents, ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  TSteerAppliedEvent,
  TActivityLabelEvent,
  TReasoningLabelEvent,
} from 'librechat-data-provider';
import type { StepEvent } from '../stream/state';
import {
  applyActivityLabelPart,
  offsetActivityPhaseBoundary,
  findActivityLabelMessageIndex,
} from './activityLabels';
import {
  applyPendingAction,
  countTaggedApprovalParts,
  findPendingActionMessageIndex,
} from '../pending';
import { applyReasoningLabel, findReasoningLabelMessageIndex } from './reasoningLabels';
import { applySteerPart, findSteerMessageIndex } from '../steer/steer';

/**
 * What a stream's side frames need to know about the turn they land on. The server claims
 * content indexes in the space of the generation it is running; the list can differ from that
 * space in two ways, and both are the caller's to report.
 */
export type PlacementContext = {
  /**
   * The ids the in-flight response may still be drawn under before its first run step renames it
   * to the server's id: the submission's placeholder, then the padded form of the user message.
   */
  placeholderIds?: readonly (string | null | undefined)[];
  /**
   * How many parts an edited resubmission kept ahead of the new content, which every
   * server-claimed index shifts past. Zero when nothing was kept, or once a resume snapshot
   * replaced the response's content.
   */
  prefixLength?: number;
  /** Whether the generation's first text or reasoning part merged into the prefix's last part. */
  foldedFirstPart?: boolean;
};

/** Where one frame landed. `undefined` from a `place*` function means its response is not in the list. */
export type Placement = {
  /** The response's index in the list. */
  index: number;
  /** The response with the frame applied; the same reference when nothing changed. */
  message: TMessage;
  changed: boolean;
  /**
   * False while part of what the frame targets has not been drawn yet, so the frame should be
   * placed again once the response has more content.
   */
  settled: boolean;
};

type PhaseLabelPart = TActivityLabelEvent['part'] & {
  activity_label_type?: 'phase';
  activity_start_index?: number;
  activity_end_index?: number;
};

const placed = (
  messages: TMessage[],
  index: number,
  message: TMessage,
  settled = true,
): Placement => ({ index, message, changed: message !== messages[index], settled });

/** Places an injected steer part on the response it was applied to. */
export function placeSteer(
  messages: TMessage[],
  event: TSteerAppliedEvent,
  { placeholderIds = [], prefixLength = 0 }: PlacementContext = {},
): Placement | undefined {
  const index = findSteerMessageIndex(messages, event, placeholderIds);
  if (index < 0) {
    return undefined;
  }
  const shifted =
    typeof event.index === 'number' && prefixLength > 0
      ? { ...event, index: event.index + prefixLength }
      : event;
  return placed(messages, index, applySteerPart(messages[index], shifted));
}

/**
 * Places an activity label at the content index the server claimed for it. Tool cards and the
 * label heading them must land in one index space: a label shifted differently from its tools
 * would overwrite another part, and a later fill would miss its own reservation.
 */
export function placeActivityLabel(
  messages: TMessage[],
  event: TActivityLabelEvent,
  { placeholderIds = [], prefixLength = 0, foldedFirstPart = false }: PlacementContext = {},
): Placement | undefined {
  const index = findActivityLabelMessageIndex(messages, event, placeholderIds);
  if (index < 0) {
    return undefined;
  }
  if (prefixLength <= 0) {
    return placed(messages, index, applyActivityLabelPart(messages[index], event));
  }
  const phasePart = event.part as PhaseLabelPart;
  let part: PhaseLabelPart = phasePart;
  if (
    phasePart.activity_label_type === 'phase' &&
    typeof phasePart.activity_start_index === 'number'
  ) {
    let start = phasePart.activity_start_index + prefixLength;
    /** Only a recorded merge of the generation's first part moves the phase's start back: an
     *  empty slot ahead of it may just be a tool that has not been drawn yet. */
    if (
      phasePart.activity_start_index === 0 &&
      start > 0 &&
      foldedFirstPart &&
      messages[index]?.content?.[start - 1] != null
    ) {
      start -= 1;
    }
    part = {
      ...phasePart,
      activity_start_index: start,
      ...(typeof phasePart.activity_end_index === 'number' && {
        activity_end_index: offsetActivityPhaseBoundary(
          phasePart.activity_end_index,
          prefixLength,
          foldedFirstPart,
        ),
      }),
    };
  }
  return placed(
    messages,
    index,
    applyActivityLabelPart(messages[index], { ...event, index: event.index + prefixLength, part }),
  );
}

/** Writes a generated title onto the reasoning part it names, which is unsettled until drawn. */
export function placeReasoningLabel(
  messages: TMessage[],
  event: TReasoningLabelEvent,
  { prefixLength = 0, foldedFirstPart = false }: PlacementContext = {},
): Placement | undefined {
  const index = findReasoningLabelMessageIndex(messages, event);
  if (index < 0) {
    return undefined;
  }
  let contentIndex = event.index + prefixLength;
  if (
    prefixLength > 0 &&
    event.index === 0 &&
    foldedFirstPart &&
    messages[index]?.content?.[contentIndex - 1]?.type === ContentTypes.THINK
  ) {
    contentIndex -= 1;
  }
  const message = applyReasoningLabel(messages[index], { ...event, index: contentIndex });
  const drawn = messages[index]?.content?.[contentIndex]?.type === ContentTypes.THINK;
  return placed(messages, index, message, message !== messages[index] || drawn);
}

/**
 * Maps a pause onto the response it interrupts, so its approval or question controls are drawn.
 * A tool approval can name several calls whose parts are drawn at different times, and it is
 * unsettled until every one of them carries the approval; a question is unsettled until its
 * part is written.
 */
export function placePendingAction(
  messages: TMessage[],
  pendingAction: Agents.PendingAction,
): Placement | undefined {
  const index = findPendingActionMessageIndex(messages, pendingAction);
  if (index < 0) {
    return undefined;
  }
  const message = applyPendingAction(messages[index], pendingAction);
  const { payload } = pendingAction;
  const settled =
    payload.type === 'tool_approval'
      ? countTaggedApprovalParts(message, pendingAction.actionId) >= payload.action_requests.length
      : message !== messages[index];
  return placed(messages, index, message, settled);
}

/** A pending MCP OAuth prompt as the step events that draw the tool call it pauses. */
export function oauthPromptSteps(prompt: Agents.PendingMCPOAuthPrompt): StepEvent[] {
  const toolCall: Agents.ToolCall = {
    id: prompt.toolCallId,
    name: prompt.toolName,
    args: '',
    type: ToolCallTypes.TOOL_CALL,
  };
  const toolCallDelta: Agents.ToolCallChunk = {
    id: prompt.toolCallId,
    name: prompt.toolName,
    args: '',
  };
  return [
    {
      event: StepEvents.ON_RUN_STEP,
      data: {
        id: prompt.stepId,
        runId: prompt.runId,
        index: prompt.index,
        type: StepTypes.TOOL_CALLS,
        stepDetails: { type: StepTypes.TOOL_CALLS, tool_calls: [toolCall] },
      },
    },
    {
      event: StepEvents.ON_RUN_STEP_DELTA,
      data: {
        id: prompt.stepId,
        delta: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [toolCallDelta],
          auth: prompt.authURL,
          expires_at: prompt.expiresAt,
        },
      },
    },
  ];
}

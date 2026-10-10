import { Constants, ContentTypes, ToolCallTypes, getNonEmptyValue } from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  PartMetadata,
  ContentMetadata,
  EventSubmission,
  SummaryContentPart,
  TMessageContentParts,
} from 'librechat-data-provider';
import { isAskUserQuestionPart, isAnsweredAskUserQuestionPart } from '~/utils/approval';

/**
 * Pure content-part primitives behind `useStepHandler`.
 *
 * Invariant every function here keeps: a part's position in `message.content` is its step index
 * (plus the retained edit prefix). Parts are written in place, never spliced, so a slot that
 * arrives early leaves holes rather than shifting later parts.
 *
 * AI SDK mapping, for orientation only: `message.content` is `UIMessage.parts`, and the part
 * types map as `text` to `text`, `think` to `reasoning`, `tool_call` to `tool-<name>`,
 * `image_file`/`image_url` to `file`, and `summary`/`agent_update` to `data-*` parts.
 */

export type TextPhase = 'commentary' | 'final_answer';

type MessageDeltaUpdate = {
  type: ContentTypes.TEXT;
  text: string;
  tool_call_ids?: string[];
  phase?: TextPhase;
};

type ReasoningDeltaUpdate = { type: ContentTypes.THINK; think: string };

type AllContentTypes =
  | ContentTypes.TEXT
  | ContentTypes.THINK
  | ContentTypes.TOOL_CALL
  | ContentTypes.IMAGE_FILE
  | ContentTypes.IMAGE_URL
  | ContentTypes.SUMMARY
  | ContentTypes.ERROR;

export const isOAuthToolCallName = (name?: string) =>
  typeof name === 'string' && name.startsWith(`oauth${Constants.mcp_delimiter}`);

const isOAuthToolCallContent = (part?: Partial<TMessageContentParts>) => {
  if (part?.type !== ContentTypes.TOOL_CALL || !('tool_call' in part)) {
    return false;
  }
  const { tool_call: toolCall } = part;
  const name = toolCall != null && 'name' in toolCall ? toolCall.name : undefined;
  return isOAuthToolCallName(name);
};

/**
 * Index offset for an edited resubmission: the server indexes only the NEW content, so incoming
 * indices shift past the prefix the client kept.
 *
 * Reads the length CAPTURED when the submission was built rather than the live
 * `initialResponse.content` array, because a resume sync REPLACES that array with the server's
 * completion-local snapshot, whose length describes the new generation, not the retained prefix.
 *
 * `editPrefixCleared` means that sync also replaced the RENDERED content: the prefix is gone from
 * the message and server indices are already absolute, so any offset would write past the end.
 *
 * `initialContent` stays the live array: it seeds a response that is not in the map yet, and
 * post-sync the seeding path correctly falls back to the rendered content instead.
 */
export function getEditPrefix(submission: EventSubmission): {
  initialContent: TMessageContentParts[];
  editPrefixOffset: number;
} {
  if (submission?.editedContent == null || submission?.editPrefixCleared === true) {
    return { initialContent: [], editPrefixOffset: 0 };
  }
  const initialContent = submission?.initialResponse?.content ?? [];
  return {
    initialContent,
    editPrefixOffset: submission?.editPrefixLength ?? initialContent.length,
  };
}

/**
 * Content index for a server step index. Takes the edit-prefix OFFSET rather than the prefix
 * array: after a resume sync the live array no longer describes the retained prefix, so deriving
 * the offset from its length would disagree with the offset every other event path applies.
 */
export function calculateContentIndex(
  serverIndex: number,
  editPrefixOffset: number,
  incomingContentType: string,
  existingContent?: TMessageContentParts[],
  incomingPhase?: TextPhase,
): number {
  /** Only apply -1 adjustment for TEXT or THINK types when they match existing content */
  if (
    editPrefixOffset > 0 &&
    (incomingContentType === ContentTypes.TEXT || incomingContentType === ContentTypes.THINK)
  ) {
    const targetIndex = serverIndex + editPrefixOffset - 1;
    const existingPart = existingContent?.[targetIndex];
    const existingType = existingPart?.type;
    const existingPhase = existingPart?.type === ContentTypes.TEXT ? existingPart.phase : undefined;
    /** Match final assembly: phased and legacy/unphased text cannot share
     *  a content part because the phase controls client grouping. */
    const phaseCompatible =
      incomingContentType !== ContentTypes.TEXT ||
      (incomingPhase ?? null) === (existingPhase ?? null);
    if (existingType === incomingContentType && phaseCompatible) {
      return targetIndex;
    }
  }
  return serverIndex + editPrefixOffset;
}

/** True when a delta at `contentIndex` folded into the last part of the retained edit prefix. */
export function foldsEditPrefix(
  serverIndex: number,
  editPrefixOffset: number,
  contentIndex: number,
): boolean {
  return serverIndex === 0 && editPrefixOffset > 0 && contentIndex === editPrefixOffset - 1;
}

/** Extract metadata from a run step for parallel content rendering. */
export function getStepMetadata(runStep: Agents.RunStep | undefined): ContentMetadata | undefined {
  if (!runStep?.agentId && runStep?.groupId == null) {
    return undefined;
  }
  return {
    agentId: runStep.agentId,
    /** Only set when explicitly provided by the server: sequential handoffs have agentId but no
     *  groupId, parallel execution has both. */
    groupId: runStep.groupId,
  };
}

/** Starts a fresh label-revision domain when a different reasoning step
 * reuses or folds into an existing THINK slot. The step id is stamped before
 * the first generated title so compacted resume snapshots can still correlate
 * later label events by identity rather than relying only on a sparse index. */
export function prepareReasoningPartForStep(
  message: TMessage,
  index: number,
  stepId: string,
): TMessage {
  const current = message.content?.[index];
  if (current?.type !== ContentTypes.THINK || current.reasoning_label_step_id === stepId) {
    return message;
  }
  const nextPart = { ...current };
  delete nextPart.reasoning_label;
  delete nextPart.reasoning_label_attempts;
  delete nextPart.reasoning_label_submitted_chars;
  delete nextPart.reasoning_label_revision;
  delete nextPart.reasoning_label_status;
  nextPart.reasoning_label_step_id = stepId;
  const nextContent = [...(message.content ?? [])];
  nextContent[index] = nextPart;
  return { ...message, content: nextContent };
}

/**
 * Writes one incoming part into `message.content[index]` and returns the next message. Text and
 * reasoning append, tool calls merge (args concatenate until they arrive as an object), summaries
 * concatenate their content, and a part of a different type never overwrites an occupied slot.
 * Returns the input message unchanged when the part is rejected.
 */
export function updateContent(
  message: TMessage,
  index: number,
  contentPart: Agents.MessageContentComplex,
  finalUpdate = false,
  metadata?: ContentMetadata,
): TMessage {
  const contentType = contentPart.type ?? '';
  if (!contentType) {
    console.warn('No content type found in content part');
    return message;
  }

  const incomingOAuthToolCall =
    contentType === ContentTypes.TOOL_CALL &&
    'tool_call' in contentPart &&
    isOAuthToolCallName(contentPart.tool_call?.name);

  let updatedContent = [...(message.content || [])] as Array<
    Partial<TMessageContentParts> | undefined
  >;

  const oauthPromptOccupiesSlot = isOAuthToolCallContent(updatedContent[index]);
  if (!incomingOAuthToolCall && oauthPromptOccupiesSlot) {
    updatedContent = updatedContent.filter((part) => !isOAuthToolCallContent(part));
  }

  /**
   * The synthetic ask-user-question card is pause-scoped UI appended at the end
   * of the content, exactly the ABSOLUTE index the resumed segment streams
   * into. Once real content arrives for that slot the pause is over: displace
   * the card (same displacement pattern as the OAuth prompt above) instead of
   * dropping the incoming part as a type mismatch. Covers the streaming
   * handler's own in-flight message copy, reconnecting tabs, and other devices:
   * the store-level strip on answer submit can't reach those.
   */
  if (isAskUserQuestionPart(updatedContent[index])) {
    updatedContent[index] = undefined;
  } else if (updatedContent.some(isAnsweredAskUserQuestionPart)) {
    /**
     * An ALREADY-ANSWERED card the resumed segment streams around rather than
     * into: the first event after the resume re-renders the ask tool_call at
     * ITS OWN index, so the slot test above never fires and this handler's
     * cached copy, which still holds the card the answer-submit stripped from
     * the store, gets written back, reopening the popover with its options
     * locked. Only cards the user actually answered are dropped, so an event
     * racing a still-live pause can't take its card down. Preserve sparse
     * absolute indices: compacting holes can move an older tool call into a
     * text slot until the terminal snapshot repairs the rendered order.
     */
    updatedContent = updatedContent.map((part) =>
      isAnsweredAskUserQuestionPart(part) ? undefined : part,
    );
  }

  if (!updatedContent[index] && contentType !== ContentTypes.TOOL_CALL) {
    updatedContent[index] = { type: contentPart.type as AllContentTypes };
  }

  /** Prevent overwriting an existing content part with a different type */
  const existingType = (updatedContent[index]?.type as string | undefined) ?? '';
  if (
    existingType &&
    existingType !== contentType &&
    !contentType.startsWith(existingType) &&
    !existingType.startsWith(contentType)
  ) {
    console.warn('Content type mismatch', { existingType, contentType, index });
    return message;
  }

  if (
    contentType.startsWith(ContentTypes.TEXT) &&
    ContentTypes.TEXT in contentPart &&
    typeof contentPart.text === 'string'
  ) {
    const currentContent = updatedContent[index] as MessageDeltaUpdate;
    const incomingContent = contentPart as MessageDeltaUpdate;
    const phase = incomingContent.phase ?? currentContent.phase;
    const update: MessageDeltaUpdate = {
      type: ContentTypes.TEXT,
      text: (currentContent.text || '') + incomingContent.text,
      ...(phase != null && { phase }),
    };

    if ('tool_call_ids' in contentPart && contentPart.tool_call_ids != null) {
      update.tool_call_ids = contentPart.tool_call_ids;
    }
    updatedContent[index] = update;
  } else if (
    contentType.startsWith(ContentTypes.AGENT_UPDATE) &&
    ContentTypes.AGENT_UPDATE in contentPart &&
    contentPart.agent_update
  ) {
    const update: Agents.AgentUpdate = {
      type: ContentTypes.AGENT_UPDATE,
      agent_update: contentPart.agent_update,
    };

    updatedContent[index] = update;
  } else if (
    contentType.startsWith(ContentTypes.THINK) &&
    ContentTypes.THINK in contentPart &&
    typeof contentPart.think === 'string'
  ) {
    const currentContent = updatedContent[index] as ReasoningDeltaUpdate;
    const update: ReasoningDeltaUpdate = {
      ...currentContent,
      type: ContentTypes.THINK,
      think: (currentContent.think || '') + contentPart.think,
    };

    updatedContent[index] = update;
  } else if (contentType === ContentTypes.IMAGE_URL && 'image_url' in contentPart) {
    const currentContent = updatedContent[index] as {
      type: ContentTypes.IMAGE_URL;
      image_url?: string;
    };
    updatedContent[index] = {
      ...currentContent,
      image_url: currentContent.image_url ?? contentPart.image_url,
    };
  } else if (contentType === ContentTypes.SUMMARY) {
    const currentSummary = updatedContent[index] as SummaryContentPart | undefined;
    const incoming = contentPart as SummaryContentPart;
    updatedContent[index] = {
      ...incoming,
      content: [...(currentSummary?.content ?? []), ...(incoming.content ?? [])],
    };
  } else if (contentType === ContentTypes.TOOL_CALL && 'tool_call' in contentPart) {
    const existingContent = updatedContent[index] as Agents.ToolCallContent | undefined;
    const existingToolCall = existingContent?.tool_call as
      | (Agents.ToolCall & PartMetadata)
      | undefined;
    const toolCallArgs = (contentPart.tool_call as Agents.ToolCall).args;
    /** When args are a valid object, they are likely already invoked */
    let args =
      finalUpdate || typeof existingToolCall?.args === 'object' || typeof toolCallArgs === 'object'
        ? contentPart.tool_call.args
        : (existingToolCall?.args ?? '') + (toolCallArgs ?? '');
    /** Preserve previously streamed args when final update omits them */
    if (finalUpdate && args == null && existingToolCall?.args != null) {
      args = existingToolCall.args;
    }

    const id = getNonEmptyValue([contentPart.tool_call.id, existingToolCall?.id]) ?? '';
    const name = getNonEmptyValue([contentPart.tool_call.name, existingToolCall?.name]) ?? '';

    const newToolCall: Agents.ToolCall & PartMetadata = {
      id,
      name,
      args,
      execution: contentPart.tool_call.execution ?? existingToolCall?.execution,
      stepId: getNonEmptyValue([contentPart.tool_call.stepId, existingToolCall?.stepId]),
      type: ToolCallTypes.TOOL_CALL,
      auth: contentPart.tool_call.auth,
      expires_at: contentPart.tool_call.expires_at,
      toolPreparationStartedAt:
        contentPart.tool_call.toolPreparationStartedAt ??
        existingToolCall?.toolPreparationStartedAt,
      toolDispatchedAt:
        contentPart.tool_call.toolDispatchedAt ?? existingToolCall?.toolDispatchedAt,
    };

    if (finalUpdate) {
      newToolCall.progress = 1;
      newToolCall.output = contentPart.tool_call.output;
      if (
        'inputValidationError' in contentPart.tool_call &&
        contentPart.tool_call.inputValidationError === true
      ) {
        Object.assign(newToolCall, { inputValidationError: true });
      }
      if (contentPart.tool_call.executor != null) {
        newToolCall.executor = contentPart.tool_call.executor;
      }
    }

    updatedContent[index] = {
      type: ContentTypes.TOOL_CALL,
      tool_call: newToolCall,
    };
  }

  /** Metadata goes on last so no branch above overwrites it. The part is copied rather than
   *  mutated: an untouched slot still holds the caller's object. */
  if (metadata?.agentId != null || metadata?.groupId != null) {
    updatedContent[index] = {
      ...updatedContent[index],
      ...(metadata.agentId != null && { agentId: metadata.agentId }),
      ...(metadata.groupId != null && { groupId: metadata.groupId }),
    } as Partial<TMessageContentParts>;
  }

  return { ...message, content: updatedContent as TMessageContentParts[] };
}

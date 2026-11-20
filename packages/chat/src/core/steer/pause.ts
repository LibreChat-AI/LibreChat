import { ContentTypes } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import { findLiveAskUserQuestion } from '../ask';

/** The message the pause predicates judge: the caller's resolved active-branch
 *  tail when it passed one, else the latest assistant in the supplied cache.
 *  Passing the tail is what stops a cached sibling branch from deciding for
 *  the branch on screen. */
function resolvePauseSubject(
  messagesOrMessage: TMessage[] | TMessage | null | undefined,
  activeTail?: TMessage | null,
): TMessage | null | undefined {
  if (activeTail !== undefined) {
    return activeTail;
  }
  if (!Array.isArray(messagesOrMessage)) {
    return messagesOrMessage;
  }
  for (let index = messagesOrMessage.length - 1; index >= 0; index--) {
    if (messagesOrMessage[index].isCreatedByUser === false) {
      return messagesOrMessage[index];
    }
  }
  return null;
}

/** True when the latest assistant message carries an unresolved tool approval:
 *  the run is (or is about to be) paused, so a steer POST would 409.
 *
 *  Pass the active branch tail whenever it has been resolved; without it this
 *  falls back to array order over the cache. */
export function hasLiveToolApproval(
  messagesOrMessage: TMessage[] | TMessage | null | undefined,
  activeTail?: TMessage | null,
): boolean {
  const message = resolvePauseSubject(messagesOrMessage, activeTail);
  if (message?.isCreatedByUser !== false) {
    return false;
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((part: TMessageContentParts | undefined) => {
    if (part?.type !== ContentTypes.TOOL_CALL) {
      return false;
    }
    const toolCall = part[ContentTypes.TOOL_CALL] as
      | { approval?: unknown; output?: string | null }
      | undefined;
    return toolCall?.approval != null && (toolCall.output?.length ?? 0) === 0;
  });
}

export interface LiveMessageState {
  approval: boolean;
  parentMessageId?: string;
}

export function selectLiveMessageState(message: TMessage | null): LiveMessageState {
  let parentMessageId: string | undefined;
  if (message?.isCreatedByUser === false && typeof message.messageId === 'string') {
    parentMessageId = message.clientQueueParentMessageId ?? message.messageId;
  }
  return { approval: hasLiveToolApproval(message), parentMessageId };
}

/**
 * The ONE during-run pause predicate. Both an unresolved tool approval and a
 * live `ask_user_question` suspend the generation while keeping its submission
 * slot occupied, so a steer POST would 409 in either case.
 *
 * Shared by the composer and the in-thread pending steers so a control is
 * never enabled on one surface while the other correctly refuses. Callers
 * should pass the active branch tail when they have resolved it; this prevents
 * a cached sibling from changing the result.
 */
export function hasLiveRunPause(
  messagesOrMessage: TMessage[] | TMessage | null | undefined,
  activeTail?: TMessage | null,
): boolean {
  /* Legacy callers hand over the whole cache without a resolved tail; keep
     scanning it for them, but once a caller resolves the active branch only
     that branch decides. */
  const questionSource =
    activeTail === undefined && Array.isArray(messagesOrMessage)
      ? messagesOrMessage
      : [resolvePauseSubject(messagesOrMessage, activeTail)].filter(
          (message): message is TMessage => message != null,
        );
  return (
    hasLiveToolApproval(messagesOrMessage, activeTail) ||
    findLiveAskUserQuestion(questionSource) != null
  );
}

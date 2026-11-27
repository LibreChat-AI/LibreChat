import { v4 } from 'uuid';
import { Constants } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';

export const STREAM_START_FAILED_METADATA_KEY = 'streamStartFailed';

/** Whether the message records a start-generation request that never opened a stream. */
export const hasStreamStartFailed = (message?: Pick<TMessage, 'metadata'> | null): boolean =>
  message?.metadata?.[STREAM_START_FAILED_METADATA_KEY] === true;

export const getAppendParentMessageId = ({
  latestMessage,
  currentMessages,
}: {
  latestMessage: TMessage | null;
  currentMessages: TMessage[];
}): string => {
  if (!latestMessage) {
    return Constants.NO_PARENT;
  }

  if (!hasStreamStartFailed(latestMessage)) {
    return latestMessage.messageId;
  }

  const failedUserMessage = currentMessages.find(
    (message) => message.messageId === latestMessage.parentMessageId,
  );
  if (failedUserMessage?.isCreatedByUser !== true) {
    return latestMessage.messageId;
  }

  return failedUserMessage.parentMessageId ?? Constants.NO_PARENT;
};

export const hasPendingAssistantParent = (message: TMessage | null): boolean =>
  !!message?.messageId &&
  message.isCreatedByUser !== true &&
  message.messageId.endsWith('_') &&
  message.createdAt == null &&
  message.updatedAt == null &&
  !hasStreamStartFailed(message);

type RegenerateTargetResponseArgs = {
  messages: TMessage[];
  parentMessageId?: string | null;
  targetResponseMessageId?: string | null;
  latestMessage?: TMessage | null;
};

const isAssistantResponseForParent = (
  message: TMessage | null | undefined,
  parentMessageId?: string | null,
): message is TMessage =>
  !!message &&
  !message.isCreatedByUser &&
  !!parentMessageId &&
  message.parentMessageId === parentMessageId;

export function getPreliminaryRegenerateResponseMessageId(
  responseMessageId?: string | null,
): string | null {
  if (typeof responseMessageId !== 'string' || responseMessageId.length === 0) {
    return null;
  }

  if (responseMessageId.length > Constants.MAX_RESPONSE_MESSAGE_ID_LENGTH) {
    return `${v4()}_`;
  }

  let end = responseMessageId.length;
  while (end > 0 && responseMessageId.charCodeAt(end - 1) === 95) {
    end--;
  }
  /** Keep the placeholder distinct without truncating an existing response identity. */
  return end >= Constants.MAX_RESPONSE_MESSAGE_ID_LENGTH
    ? `${v4()}_`
    : `${responseMessageId.slice(0, end)}_`;
}

export function getRegenerateTargetResponseMessage({
  messages,
  parentMessageId,
  targetResponseMessageId,
  latestMessage,
}: RegenerateTargetResponseArgs): TMessage | null {
  if (!parentMessageId) {
    return null;
  }

  if (targetResponseMessageId) {
    const targetResponse = messages.find(
      (message) =>
        message.messageId === targetResponseMessageId &&
        isAssistantResponseForParent(message, parentMessageId),
    );
    if (targetResponse) {
      return targetResponse;
    }
  }

  if (isAssistantResponseForParent(latestMessage, parentMessageId)) {
    return latestMessage;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isAssistantResponseForParent(message, parentMessageId)) {
      return message;
    }
  }

  return null;
}

export function getRegenerateSubmissionMessages({
  messages,
  targetResponseMessage,
  initialResponseId,
}: {
  messages: TMessage[];
  targetResponseMessage?: TMessage | null;
  initialResponseId?: string | null;
}): TMessage[] {
  if (targetResponseMessage?.messageId) {
    /**
     * Remove the response being regenerated and its descendants only: NOT a
     * flat `slice(0, targetIndex)`, which also drops unrelated sibling branches
     * that merely sit later in the array. That collapse made the optimistic
     * render briefly lose other branches mid-regenerate (visible flash, and the
     * scroll jumping to the shrunken content). Keeping them holds the thread
     * (and scroll) steady. This array is render-only; the server regenerates
     * from `parentMessageId`, so removing by subtree never affects the payload.
     */
    const removed = new Set<string>([targetResponseMessage.messageId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const message of messages) {
        const parentMessageId = message.parentMessageId;
        if (
          parentMessageId != null &&
          removed.has(parentMessageId) &&
          !removed.has(message.messageId)
        ) {
          removed.add(message.messageId);
          grew = true;
        }
      }
    }
    return messages.filter((message) => !removed.has(message.messageId));
  }

  return messages.filter((msg) => msg.messageId !== initialResponseId);
}

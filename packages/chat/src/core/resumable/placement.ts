import type { Agents, TMessage, TSubmission, EventSubmission } from 'librechat-data-provider';
import { preferDefinedString } from './messages';

export type ResumeMessageIndexes = {
  userIndex: number;
  responseIndex: number;
  preliminaryUserIndex: number;
  preliminaryResponseIndex: number;
};

export const getResumeMessageIndexes = (
  messages: TMessage[],
  userMessageId: string,
  responseMessageId: string,
  preliminaryUserMessageId?: string,
  preliminaryResponseMessageId?: string,
): ResumeMessageIndexes => {
  let userIndex = -1;
  let responseIndex = -1;
  let preliminaryUserIndex = -1;
  let preliminaryResponseIndex = -1;
  const hasPreliminaryResponse = preliminaryResponseMessageId?.endsWith('_') === true;
  const eligiblePreliminaryUserId =
    hasPreliminaryResponse && preliminaryUserMessageId && preliminaryUserMessageId !== userMessageId
      ? preliminaryUserMessageId
      : undefined;
  const eligiblePreliminaryResponseId =
    hasPreliminaryResponse && preliminaryResponseMessageId !== responseMessageId
      ? preliminaryResponseMessageId
      : undefined;

  for (let index = 0; index < messages.length; index++) {
    const messageId = messages[index]?.messageId;
    if (userIndex < 0 && messageId === userMessageId) {
      userIndex = index;
    }
    if (responseIndex < 0 && messageId === responseMessageId) {
      responseIndex = index;
    }
    if (
      preliminaryUserIndex < 0 &&
      eligiblePreliminaryUserId &&
      messageId === eligiblePreliminaryUserId
    ) {
      preliminaryUserIndex = index;
    }
    if (
      preliminaryResponseIndex < 0 &&
      eligiblePreliminaryResponseId &&
      messageId === eligiblePreliminaryResponseId
    ) {
      preliminaryResponseIndex = index;
    }
  }

  return { userIndex, responseIndex, preliminaryUserIndex, preliminaryResponseIndex };
};

export const mergeResumeMessages = (
  messages: TMessage[],
  userMessage: TMessage,
  responseMessage: TMessage,
  indexes: ResumeMessageIndexes,
  /**
   * An anchored run (a compaction) owns no user row. Its user-message slot
   * holds the leaf the summary hangs off, a row the transcript already has:
   * merging the slot onto it would replace that answer with an empty user
   * message, and inserting it would duplicate its id. Either way the row loses
   * its parent and `buildTree` files it as a phantom root, folding the thread.
   */
  anchoredUserMessage = false,
): TMessage[] => {
  const nextMessages = [...messages];
  let { userIndex, responseIndex, preliminaryResponseIndex } = indexes;
  const { preliminaryUserIndex } = indexes;

  if (preliminaryUserIndex >= 0 && !anchoredUserMessage) {
    if (userIndex >= 0) {
      nextMessages.splice(preliminaryUserIndex, 1);
      if (userIndex > preliminaryUserIndex) {
        userIndex -= 1;
      }
      if (responseIndex > preliminaryUserIndex) {
        responseIndex -= 1;
      }
      if (preliminaryResponseIndex > preliminaryUserIndex) {
        preliminaryResponseIndex -= 1;
      }
    } else {
      nextMessages[preliminaryUserIndex] = {
        ...nextMessages[preliminaryUserIndex],
        ...userMessage,
      };
      userIndex = preliminaryUserIndex;
    }
  }

  if (preliminaryResponseIndex >= 0) {
    if (responseIndex >= 0) {
      nextMessages.splice(preliminaryResponseIndex, 1);
      if (userIndex > preliminaryResponseIndex) {
        userIndex -= 1;
      }
      if (responseIndex > preliminaryResponseIndex) {
        responseIndex -= 1;
      }
    } else {
      nextMessages[preliminaryResponseIndex] = {
        ...nextMessages[preliminaryResponseIndex],
        ...responseMessage,
      };
      responseIndex = preliminaryResponseIndex;
    }
  }

  if (userIndex >= 0 && !anchoredUserMessage) {
    nextMessages[userIndex] = { ...nextMessages[userIndex], ...userMessage };
  }

  if (responseIndex >= 0) {
    nextMessages[responseIndex] = { ...nextMessages[responseIndex], ...responseMessage };
  }

  if (anchoredUserMessage) {
    return responseIndex >= 0 ? nextMessages : [...nextMessages, responseMessage];
  }

  if (userIndex >= 0 && responseIndex >= 0) {
    return nextMessages;
  }

  if (userIndex >= 0) {
    return [...nextMessages, responseMessage];
  }

  if (responseIndex >= 0) {
    nextMessages.splice(responseIndex, 0, userMessage);
    return nextMessages;
  }

  return [...nextMessages, userMessage, responseMessage];
};

/** Where a resume snapshot's response landed in the list, and what the list is now. */
export type ResumedResponsePlacement = {
  messages: TMessage[];
  response: TMessage;
  /** The index the response already held, under its durable id or its preliminary one; else -1. */
  responseIndex: number;
  /** The list's own content was kept because the snapshot carried none. */
  preservedLoadedContent: boolean;
};

/**
 * Rebuilds the response a resume snapshot describes and places it, with its user turn, in the
 * list. The snapshot's aggregated content is authoritative over what the list holds, with one
 * exception: an EMPTY snapshot never erases content already loaded for the same response, which
 * would leave a bare cursor.
 *
 * When loaded content is not preserved, the response holds completion-local content indexed from
 * zero, so the caller must stop offsetting later steps by an edit's retained prefix.
 */
export function placeResumedResponse({
  messages,
  submission,
  userMessage,
  resumeState,
  previous,
}: {
  messages: TMessage[];
  /** The submission already rebuilt from the snapshot (`buildResumeEventSubmission`). */
  submission: EventSubmission;
  userMessage: TMessage;
  resumeState: Agents.ResumeState;
  /**
   * The submission the run held before the snapshot. Its optimistic rows are replaced in place
   * when the snapshot assigns the turn its durable ids.
   */
  previous?: Pick<TSubmission, 'userMessage' | 'initialResponse'> | null;
}): ResumedResponsePlacement {
  const { initialResponse } = submission;
  const preliminaryResponseMessageId = previous?.initialResponse?.messageId;
  const previousUserMessageId = previous?.userMessage?.messageId;
  const preliminaryUserMessageId =
    previousUserMessageId &&
    (previous?.initialResponse?.parentMessageId === previousUserMessageId ||
      preliminaryResponseMessageId === `${previousUserMessageId}_`)
      ? previousUserMessageId
      : undefined;
  const responseId = initialResponse.messageId;
  const resumedContent = initialResponse.content;
  const indexes = getResumeMessageIndexes(
    messages,
    userMessage.messageId,
    responseId,
    preliminaryUserMessageId,
    preliminaryResponseMessageId,
  );
  const responseIndex =
    indexes.responseIndex >= 0 ? indexes.responseIndex : indexes.preliminaryResponseIndex;
  const anchored = submission.compact === true;

  if (responseIndex < 0) {
    const response = {
      ...initialResponse,
      messageId: responseId,
      parentMessageId: userMessage.messageId,
      content: resumedContent,
      isCreatedByUser: false,
    } as TMessage;
    return {
      messages: mergeResumeMessages(messages, userMessage, response, indexes, anchored),
      response,
      responseIndex,
      preservedLoadedContent: false,
    };
  }

  const loaded = messages[responseIndex];
  const loadedContent = loaded?.content;
  /** Require an existing content array so it is never swapped for `undefined`. */
  const preservedLoadedContent =
    (resumedContent?.length ?? 0) === 0 && Array.isArray(loadedContent) && loadedContent.length > 0;
  const response = {
    ...initialResponse,
    ...loaded,
    messageId: responseId,
    parentMessageId: userMessage.messageId,
    content: preservedLoadedContent ? loadedContent : resumedContent,
    sender: loaded?.sender ?? initialResponse.sender,
    iconURL: preferDefinedString(loaded?.iconURL, initialResponse.iconURL ?? resumeState.iconURL),
    model: preferDefinedString(loaded?.model, initialResponse.model ?? resumeState.model),
  } as TMessage;
  return {
    messages: mergeResumeMessages(messages, userMessage, response, indexes, anchored),
    response,
    responseIndex,
    preservedLoadedContent,
  };
}

export function hasSubmissionUserMessage(
  submission: TSubmission | null,
  messages: TMessage[] | undefined,
  conversationId: string | undefined,
): boolean {
  const userMessageId = submission?.userMessage?.messageId;
  if (!userMessageId || !conversationId || !messages?.length) {
    return false;
  }

  return messages.some(
    (message) =>
      message.isCreatedByUser === true &&
      message.messageId === userMessageId &&
      message.conversationId === conversationId,
  );
}

export function resumeStateMatchesSubmission(
  streamStatus: { resumeState?: Agents.ResumeState } | undefined,
  submission: TSubmission | null,
): boolean {
  const resumeState = streamStatus?.resumeState;
  if (!resumeState || !submission) {
    return false;
  }

  const userMessageId = submission.userMessage?.messageId;
  if (userMessageId && resumeState.userMessage?.messageId === userMessageId) {
    return true;
  }

  const responseMessageId = submission.initialResponse?.messageId;
  return !!responseMessageId && resumeState.responseMessageId === responseMessageId;
}

/**
 * The row that names the branch a resumed run belongs to when its own response
 * is not in the loaded history yet. A compaction's user-message slot is the leaf
 * it summarizes up to and carries no parent (`projectCompactionAnchor`), so
 * there the anchor itself names the branch; without this the pane restores no
 * sibling selection and a compaction started on an older branch comes back on
 * whichever branch the default lands on.
 */
function getResumeBranchFallbackMessageId(
  resumeState: Agents.ResumeState,
): string | null | undefined {
  return resumeState.userMessage?.parentMessageId ?? resumeState.userMessage?.messageId;
}

export function getResumeBranchTargetMessageId(
  resumeState: Agents.ResumeState,
  messages: TMessage[],
): string | null | undefined {
  const responseMessageId = resumeState.responseMessageId;
  if (!responseMessageId) {
    return getResumeBranchFallbackMessageId(resumeState);
  }

  const unpaddedResponseMessageId = responseMessageId.replace(/_+$/, '');
  let hasResponseMessage = false;
  let hasUnpaddedResponseMessage = false;

  for (const message of messages) {
    if (message.messageId === responseMessageId) {
      hasResponseMessage = true;
      break;
    }

    if (message.messageId === unpaddedResponseMessageId) {
      hasUnpaddedResponseMessage = true;
    }
  }

  if (hasResponseMessage) {
    return responseMessageId;
  }

  if (hasUnpaddedResponseMessage) {
    return unpaddedResponseMessageId;
  }

  return getResumeBranchFallbackMessageId(resumeState);
}

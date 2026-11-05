import type { Agents, TMessage, TSubmission } from 'librechat-data-provider';

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

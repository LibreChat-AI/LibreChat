import { Constants, tPresetSchema } from 'librechat-data-provider';
import type {
  TPreset,
  TMessage,
  TSubmission,
  TConversation,
  EventSubmission,
} from 'librechat-data-provider';
import { withSubmittedCodeDecision } from '../decision';

export const hasConcreteConversationId = (conversationId?: string | null): boolean =>
  !!conversationId &&
  conversationId !== Constants.NEW_CONVO &&
  conversationId !== Constants.PENDING_CONVO;

export const isInitialNewConversation = (submission: TSubmission): boolean => {
  const conversationId = submission.conversation?.conversationId;
  return !hasConcreteConversationId(conversationId);
};

const shouldHydrateMessage = (message: TMessage): boolean =>
  !hasConcreteConversationId(message.conversationId);

/** Recovery must identify the response itself: regenerations share a user
 * parent, and array order says nothing about which sibling just completed.
 * A fresh-turn placeholder has no server response ID yet; only an unambiguous
 * persisted child can stand in for it. */
export const completedResponseMessageId = (
  messages: TMessage[] | undefined,
  userMessageId: string | undefined,
  responseMessageId: string | undefined,
): string | undefined => {
  if (messages == null || userMessageId == null) {
    return undefined;
  }
  const target = responseMessageId?.replace(/_+$/, '');
  const hasResponseIdentity = target != null && target !== userMessageId;
  let candidate: string | undefined;
  let ambiguous = false;
  for (const message of messages) {
    if (message.isCreatedByUser !== false || message.parentMessageId !== userMessageId) {
      continue;
    }
    if (hasResponseIdentity) {
      if (message.messageId === target) {
        return message.messageId;
      }
      continue;
    }
    ambiguous ||= candidate != null;
    candidate = message.messageId;
  }
  return hasResponseIdentity || ambiguous ? undefined : candidate;
};

const hydrateMessageConversationId = (message: TMessage, conversationId: string): TMessage =>
  shouldHydrateMessage(message) ? { ...message, conversationId } : message;

export const preferDefinedString = (
  value?: string | null,
  fallback?: string,
): string | undefined => (value != null && value !== '' ? value : fallback);

export const getOptimisticMessages = (
  submission: TSubmission,
  conversationId: string,
  messages?: TMessage[],
): TMessage[] => {
  const sourceMessages =
    messages && messages.length > 0
      ? messages
      : [submission.userMessage, submission.initialResponse].filter(
          (message): message is TMessage => message != null,
        );

  return sourceMessages.map((message) => hydrateMessageConversationId(message, conversationId));
};

export const buildOptimisticConversation = (
  submission: TSubmission,
  conversationId: string,
): TConversation => {
  const now = new Date().toISOString();
  const messageIds = [
    submission.userMessage?.messageId,
    submission.initialResponse?.messageId,
  ].filter((messageId): messageId is string => typeof messageId === 'string' && messageId !== '');

  const conversation = {
    ...submission.conversation,
    conversationId,
    endpoint: submission.conversation.endpoint ?? null,
    title: submission.conversation.title ?? 'New Chat',
    messages: messageIds.length > 0 ? messageIds : submission.conversation.messages,
    createdAt: submission.conversation.createdAt ?? now,
    updatedAt: now,
    /** Temporary mode lives on the submission, not on the draft conversation, so
     * the optimistic record has to carry it forward or every consumer of this
     * cache entry reads a new temporary chat as an ordinary one. Only stamped
     * when true, leaving the legacy `expiredAt` inference untouched otherwise. */
    ...(submission.isTemporary === true ? { isTemporary: true } : {}),
  } as TConversation;
  return withSubmittedCodeDecision(conversation, submission)!;
};

export const hydrateSubmissionMessages = (
  submission: TSubmission,
  conversationId: string,
): TSubmission => ({
  ...submission,
  conversation: {
    ...submission.conversation,
    conversationId,
  },
  userMessage: hydrateMessageConversationId(submission.userMessage, conversationId),
  initialResponse: submission.initialResponse
    ? hydrateMessageConversationId(submission.initialResponse, conversationId)
    : submission.initialResponse,
});

/** A regenerated response is parented to the saved turn, never its unsaved replay copy. */
export const responseParentMessageId = (
  initialResponse: TMessage,
  userMessage: TMessage,
  isRegenerate?: boolean,
): string =>
  isRegenerate && initialResponse.parentMessageId
    ? initialResponse.parentMessageId
    : userMessage.messageId;

export const buildCreatedInitialResponse = ({
  initialResponse,
  userMessage,
  isRegenerate = false,
}: Pick<EventSubmission, 'initialResponse' | 'userMessage' | 'isRegenerate'>): TMessage => ({
  ...initialResponse,
  parentMessageId: responseParentMessageId(initialResponse, userMessage, isRegenerate),
  messageId:
    isRegenerate && initialResponse.messageId
      ? initialResponse.messageId
      : `${userMessage.messageId}_`,
  conversationId: userMessage.conversationId ?? initialResponse.conversationId,
});

export const isInitialNewConversationSubmission = ({
  userMessage,
}: Pick<EventSubmission, 'userMessage'>): boolean =>
  userMessage?.parentMessageId === Constants.NO_PARENT;

/**
 * Whether the run was sent from the unsaved-chat composer, which is the only case where
 * finishing it may drop the pane's new-chat draft. Regenerating or resubmitting the first turn
 * of a saved conversation keeps the root parent id, so the root parent alone cannot decide it.
 */
export const startedAsNewConversation = ({
  conversation,
  userMessage,
  isEdited,
  isRegenerate,
}: Pick<
  EventSubmission,
  'conversation' | 'userMessage' | 'isEdited' | 'isRegenerate'
>): boolean => {
  const conversationId = conversation?.conversationId;
  if (
    !conversationId ||
    conversationId === Constants.NEW_CONVO ||
    conversationId === Constants.PENDING_CONVO
  ) {
    return true;
  }

  return (
    isEdited !== true &&
    isRegenerate !== true &&
    isInitialNewConversationSubmission({ userMessage })
  );
};

export const mergeRegenerateFinalMessages = ({
  messages,
  responseMessage,
  initialResponseId,
}: {
  messages: TMessage[];
  responseMessage: TMessage;
  initialResponseId?: string | null;
}): TMessage[] => {
  const finalMessages: TMessage[] = [];
  let inserted = false;

  for (const message of messages) {
    if (!message?.messageId || message.messageId === initialResponseId) {
      continue;
    }

    if (message.messageId === responseMessage.messageId) {
      finalMessages.push(responseMessage);
      inserted = true;
      continue;
    }

    finalMessages.push(message);
  }

  if (!inserted) {
    finalMessages.push(responseMessage);
  }

  return finalMessages;
};

export const getExistingConversationAbortMessages = ({
  messages,
  currentMessages,
  regenerateMessages,
  isRegenerate = false,
}: Pick<EventSubmission, 'messages' | 'regenerateMessages' | 'isRegenerate'> & {
  currentMessages?: TMessage[];
}): TMessage[] => {
  if (!isRegenerate) {
    return [...messages];
  }

  if (regenerateMessages?.length) {
    return [...regenerateMessages];
  }

  const sourceMessages = currentMessages?.length ? currentMessages : messages;
  return [...sourceMessages];
};

export const mergeErrorMessages = ({
  messages,
  regenerateMessages,
  userMessage,
  errorMessage,
  isRegenerate = false,
}: Pick<EventSubmission, 'messages' | 'regenerateMessages' | 'userMessage' | 'isRegenerate'> & {
  errorMessage: TMessage;
}): TMessage[] => {
  if (isRegenerate) {
    const finalMessages: TMessage[] = [];
    let replaced = false;
    for (const message of regenerateMessages ?? messages) {
      if (message.messageId === errorMessage.messageId) {
        finalMessages.push(errorMessage);
        replaced = true;
      } else {
        finalMessages.push(message);
      }
    }
    if (!replaced) {
      finalMessages.push(errorMessage);
    }
    return finalMessages;
  }

  return [...messages, userMessage, errorMessage];
};

/**
 * A code approval mode picked locally is newer than any server copy of the
 * conversation: the final and abort events return the mode the run STARTED
 * with, and error recovery rebuilds from the pre-run capture. The local mode
 * therefore survives every merge and the next send carries it. Identity is
 * checked because the conversation atom is index-global: after navigating
 * elsewhere mid-run, that conversation's mode must not land in this one.
 */
export const keepLocalCodeApprovalMode = <T extends Partial<TConversation>>(
  merged: T,
  local: Partial<TConversation> | null | undefined,
  conversationId: string | null | undefined,
): T => {
  const localMode = local?.codeApprovalMode;
  if (localMode == null || local?.conversationId !== conversationId) {
    return merged;
  }
  return merged.codeApprovalMode === localMode
    ? merged
    : { ...merged, codeApprovalMode: localMode };
};

/** Preset for a conversation rebuilt after a failed or aborted run. The detail
 *  cache holds a mode picked while that run streamed; the capture only the
 *  pre-run one. */
export const buildRecoveryPreset = (
  submissionConvo: Partial<TConversation>,
  cachedConvo: TConversation | null | undefined,
  conversationId: string,
  submittedDecision?: Pick<EventSubmission, 'codeEnvironmentMode' | 'codeWorkspaces'>,
): TPreset =>
  tPresetSchema.parse(
    keepLocalCodeApprovalMode(
      submittedDecision == null
        ? submissionConvo
        : withSubmittedCodeDecision(submissionConvo as TConversation, submittedDecision)!,
      cachedConvo,
      conversationId,
    ),
  );

import { QueryKeys, Constants, ContentTypes } from 'librechat-data-provider';
import {
  selectActiveBranchTail,
  getBranchSiblingIndexesForTarget,
  getMessageBranchSiblingParentIds,
} from '@librechat/chat';
import {
  getPartKeyIndex,
  getAllContentText,
  isEmptyContentPart,
  hasStreamStartFailed,
  stripStreamedIndexStamps,
  createDualMessageContent,
  preserveStreamedContentIdentity,
  STREAM_START_FAILED_METADATA_KEY,
} from '@librechat/chat';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import type { BranchSiblingIndex } from '@librechat/chat';
import type { QueryClient } from '@tanstack/react-query';

export {
  getPartKeyIndex,
  getAllContentText,
  isEmptyContentPart,
  hasStreamStartFailed,
  stripStreamedIndexStamps,
  createDualMessageContent,
  preserveStreamedContentIdentity,
  STREAM_START_FAILED_METADATA_KEY,
};
export const TEXT_KEY_DIVIDER = '|||';

/** A locally submitted user row is not canonical until the server acknowledges it. */
export function isUnacknowledgedUserMessage(message: TMessage): boolean {
  return (
    message.isCreatedByUser === true &&
    message.clientTimestamp != null &&
    message.createdAt == null &&
    !message.privacyRevision
  );
}

export {
  selectActiveBranchTail,
  getBranchSiblingIndexesForTarget,
  getMessageBranchSiblingParentIds,
};
export type { BranchSiblingIndex };

export const getLatestText = (message?: TMessage | null, includeIndex?: boolean): string => {
  if (!message) {
    return '';
  }
  if (message.text) {
    return message.text;
  }
  if (message.content && message.content.length > 0) {
    for (let i = message.content.length - 1; i >= 0; i--) {
      const part = message.content[i] as TMessageContentParts | undefined;
      if (part && part.type !== ContentTypes.TEXT) {
        continue;
      }

      const text = (typeof part?.text === 'string' ? part.text : part?.text?.value) ?? '';
      if (text.length > 0) {
        if (includeIndex === true) {
          return `${text}-${i}`;
        } else {
          return text;
        }
      } else {
        continue;
      }
    }
  }
  return '';
};

export { isSubmittableMessage } from '@librechat/chat';

export const markStreamStartFailedMetadata = (
  metadata?: TMessage['metadata'],
): TMessage['metadata'] => ({
  ...(metadata ?? {}),
  [STREAM_START_FAILED_METADATA_KEY]: true,
});

export const scrollToEnd = (callback?: () => void) => {
  const messagesEndElement = document.getElementById('messages-end');
  if (messagesEndElement) {
    messagesEndElement.scrollIntoView({ behavior: 'instant' });
    if (callback) {
      callback();
    }
  }
};

/**
 * Removes an existing conversation's message query so reopening it starts cold, and resets the
 * NEW_CONVO query to an empty cache for immediate optimistic messages.
 *
 * @param queryClient - The React Query client instance
 * @param conversationId - The conversation ID to clear messages for
 */
export const clearMessagesCache = (
  queryClient: QueryClient,
  conversationId: string | undefined | null,
): void => {
  const convoId = conversationId ?? Constants.NEW_CONVO;

  // An absent existing-conversation cache means its history must load before sending.
  if (convoId !== Constants.NEW_CONVO) {
    queryClient.removeQueries([QueryKeys.messages, convoId], { exact: true });
  }

  queryClient.setQueryData<TMessage[]>([QueryKeys.messages, Constants.NEW_CONVO], []);
};

/**
 * True while the new-chat cache still holds the given conversation's messages: a chat's first
 * turn writes the same array under both keys, so the alias survives until it is reset. The
 * reference check covers the window before the messages carry their conversation ID.
 */
const newConversationCacheAliases = (queryClient: QueryClient, conversationId: string): boolean => {
  const conversationMessages = queryClient.getQueryData<TMessage[]>([
    QueryKeys.messages,
    conversationId,
  ]);
  const newConversationMessages = queryClient.getQueryData<TMessage[]>([
    QueryKeys.messages,
    Constants.NEW_CONVO,
  ]);

  return (
    newConversationMessages != null &&
    (newConversationMessages === conversationMessages ||
      newConversationMessages.some((message) => message.conversationId === conversationId))
  );
};

/** Removes a deleted conversation's message cache and any matching new-chat cache alias. */
export const clearDeletedConversationMessagesCache = (
  queryClient: QueryClient,
  conversationId: string,
): void => {
  const newConversationAliasesDeleted = newConversationCacheAliases(queryClient, conversationId);

  queryClient.removeQueries([QueryKeys.messages, conversationId], { exact: true });

  if (!newConversationAliasesDeleted) {
    return;
  }

  queryClient.setQueryData<TMessage[]>([QueryKeys.messages, Constants.NEW_CONVO], []);
};

/**
 * Drops the new-chat alias of a conversation that was just archived, so returning to a new chat
 * does not keep rendering it. Its own history stays cached: unlike a deleted chat, an archived
 * one can still be reopened from the archive.
 */
export const clearArchivedConversationMessagesCache = (
  queryClient: QueryClient,
  conversationId: string,
): void => {
  if (!newConversationCacheAliases(queryClient, conversationId)) {
    return;
  }

  queryClient.setQueryData<TMessage[]>([QueryKeys.messages, Constants.NEW_CONVO], []);
};

export {
  isValidTimestamp,
  getMessageTimestamp,
  getMessageAriaLabel,
  getHeaderPrefixForScreenReader,
} from '@librechat/chat/components';
export type { MessageTimestamp } from '@librechat/chat/components';

export {
  areMessageFilesEqual,
  areMessageFieldsEqual,
  isSameTailRelation,
  areMessageRowPropsEqual,
} from '@librechat/chat/react';

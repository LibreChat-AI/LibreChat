import { useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { Constants, QueryKeys, dataService } from 'librechat-data-provider';
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import type { UseQueryOptions, QueryObserverResult, QueryClient } from '@tanstack/react-query';
import type * as t from 'librechat-data-provider';
import {
  beginMessagesReplyFetch,
  completeMessagesReplyFetch,
  findConvoInAllQueries,
  isNotFoundError,
  logger,
} from '~/utils';

type StableMessagesParams = {
  pathname: string;
  result: t.TMessage[];
  isStreaming?: boolean;
  currentMessages?: t.TMessage[];
};

type ActiveJobs = {
  activeJobIds?: string[];
};

function isUnhydratedMessage(message: t.TMessage) {
  const messageId = message.messageId ?? '';
  return message.createdAt == null || message.updatedAt == null || messageId.endsWith('_');
}

function hasPendingAssistantTail(messages: t.TMessage[]) {
  const lastMessage = messages[messages.length - 1];
  const parentMessageId = lastMessage?.parentMessageId ?? '';
  return (
    lastMessage?.isCreatedByUser !== true &&
    parentMessageId !== '' &&
    parentMessageId !== Constants.NO_PARENT &&
    isUnhydratedMessage(lastMessage)
  );
}

function isMessagePrefix(result: t.TMessage[], currentMessages: t.TMessage[]) {
  return result.every((message, index) => message.messageId === currentMessages[index]?.messageId);
}

export function getStableMessages({
  pathname,
  result,
  isStreaming = false,
  currentMessages,
}: StableMessagesParams): t.TMessage[] {
  if (pathname.includes('/c/new') || !currentMessages?.length) {
    return result;
  }

  if (result.length >= currentMessages.length) {
    return result;
  }

  if (
    isStreaming &&
    hasPendingAssistantTail(currentMessages) &&
    isMessagePrefix(result, currentMessages)
  ) {
    return currentMessages;
  }

  return result;
}

export function shouldPreserveMessagesOnNotFound({
  pathname,
  isStreaming = false,
  currentMessages,
}: Pick<StableMessagesParams, 'pathname' | 'isStreaming' | 'currentMessages'>): boolean {
  if (!isStreaming || pathname.includes('/c/new') || !currentMessages?.length) {
    return false;
  }

  return hasPendingAssistantTail(currentMessages);
}

/**
 * Loads a conversation's messages for the shared `[messages, id]` cache, with settled tool calls
 * as bounded previews. Every writer of that cache uses this, so the cache never flips between
 * preview and full payloads; a reader that needs every byte (export) asks for a full load.
 */
export function fetchConversationMessages(conversationId: string): Promise<t.TMessage[]> {
  return dataService.getMessagesByConvoId(conversationId, { toolPreviews: true });
}

/**
 * The stored content of one tool-call part, for a preview the reader opened. Kept under its own
 * key and never merged into `[messages, id]`, so a refetch of the conversation cannot drop it and
 * the conversation cache keeps only previews. `revision` (see `getToolCallPreviewRevision`) is
 * part of the key, so a stored call that changes after it was fetched is fetched again.
 */
export const useToolCallPartQuery = (
  params: t.ToolCallPartParams,
  config?: UseQueryOptions<t.ToolCallPartResponse>,
  revision = '',
): QueryObserverResult<t.ToolCallPartResponse> => {
  /** The index only rides along in the request; the server locates the call by identity, so the
   *  cache does too, and a shifted index cannot fetch the same part twice. */
  const { conversationId, messageId, toolCallId, stepId, agentId } = params;
  return useQuery<t.ToolCallPartResponse>(
    [
      QueryKeys.toolCallPart,
      conversationId,
      messageId,
      toolCallId ?? '',
      stepId ?? '',
      agentId ?? '',
      revision,
    ],
    () => dataService.getToolCallPart(params),
    {
      staleTime: Infinity,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );
};

/** Most files one owner lookup names; the endpoint refuses more. */
export const SUBAGENT_ATTACHMENT_CALLS_BATCH = 32;

/**
 * The child calls of a stored message's subagent transcripts that `files` were saved under, for a
 * client holding previews: a file that reached the message after it loaded has no hint in the
 * cached preview. Answered from the stored transcripts, so it does not wait on the file being
 * saved, and keyed by the files so a newer one asks again; more files than one lookup names are
 * asked in batches. No reader is there to press retry, so a failed read retries with backoff and
 * runs again on focus and reconnect.
 */
export const useSubagentAttachmentCallsQueries = (
  params: t.SubagentAttachmentCallsParams,
  enabled: boolean,
): QueryObserverResult<t.SubagentAttachmentCallsResponse>[] => {
  const { conversationId, messageId, files } = params;
  const batches: t.SubagentAttachmentFile[][] = [];
  for (let i = 0; i < files.length; i += SUBAGENT_ATTACHMENT_CALLS_BATCH) {
    batches.push(files.slice(i, i + SUBAGENT_ATTACHMENT_CALLS_BATCH));
  }
  return useQueries({
    queries: batches.map((batch) => ({
      queryKey: [
        QueryKeys.subagentAttachmentCalls,
        conversationId,
        messageId,
        JSON.stringify(batch),
      ],
      queryFn: () =>
        dataService.getSubagentAttachmentCalls({ conversationId, messageId, files: batch }),
      enabled,
      staleTime: Infinity,
      retry: 3,
      refetchOnMount: false,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    })),
  });
};

function hasActiveJob(queryClient: QueryClient, id: string) {
  if (!id) {
    return false;
  }
  const activeJobs = queryClient.getQueryData<ActiveJobs>([QueryKeys.activeJobs]);
  return activeJobs?.activeJobIds?.includes(id) === true;
}

export const useGetMessagesByConvoId = <TData = t.TMessage[]>(
  id: string,
  config?: UseQueryOptions<t.TMessage[], unknown, TData>,
  options?: { isStreaming?: boolean },
): QueryObserverResult<TData> => {
  const location = useLocation();
  const queryClient = useQueryClient();
  const isStreaming = options?.isStreaming === true;
  const isStreamingRef = useRef(isStreaming);

  useLayoutEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  return useQuery<t.TMessage[], unknown, TData>(
    [QueryKeys.messages, id],
    async () => {
      const queryKey = [QueryKeys.messages, id];
      const messagesAtRequestStart = queryClient.getQueryData<t.TMessage[]>(queryKey);

      if (id === Constants.NEW_CONVO) {
        return messagesAtRequestStart ?? [];
      }

      const request = beginMessagesReplyFetch(
        queryClient,
        id,
        findConvoInAllQueries(queryClient, id)?.lastResponseAt,
      );
      let result: t.TMessage[];
      try {
        result = await fetchConversationMessages(id);
      } catch (error) {
        const currentMessages = queryClient.getQueryData<t.TMessage[]>(queryKey);
        if (
          messagesAtRequestStart != null &&
          currentMessages != null &&
          currentMessages !== messagesAtRequestStart
        ) {
          completeMessagesReplyFetch(queryClient, id, request, false);
          return currentMessages;
        }

        const hasLiveStream = isStreamingRef.current || hasActiveJob(queryClient, id);
        if (
          currentMessages &&
          isNotFoundError(error) &&
          shouldPreserveMessagesOnNotFound({
            pathname: location.pathname,
            currentMessages,
            isStreaming: hasLiveStream,
          })
        ) {
          logger.warn(
            'messages',
            `Messages query for convo ${id} returned 404 while cache has a pending assistant tail; path: "${location.pathname}"`,
            currentMessages,
          );
          completeMessagesReplyFetch(queryClient, id, request, false);
          return currentMessages;
        }

        completeMessagesReplyFetch(queryClient, id, request, false);
        throw error;
      }

      const currentMessages = queryClient.getQueryData<t.TMessage[]>(queryKey);
      if (
        messagesAtRequestStart != null &&
        currentMessages != null &&
        currentMessages !== messagesAtRequestStart
      ) {
        completeMessagesReplyFetch(queryClient, id, request, false);
        return currentMessages;
      }

      const stableMessages = getStableMessages({
        pathname: location.pathname,
        result,
        currentMessages,
        isStreaming: isStreamingRef.current || hasActiveJob(queryClient, id),
      });

      if (stableMessages === currentMessages) {
        logger.warn(
          'messages',
          `Messages query for convo ${id} returned fewer than cache; path: "${location.pathname}"`,
          result,
          currentMessages,
        );
      }

      completeMessagesReplyFetch(queryClient, id, request, stableMessages === result);
      return stableMessages;
    },
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );
};

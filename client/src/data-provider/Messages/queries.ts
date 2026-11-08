import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { Constants, QueryKeys, dataService } from 'librechat-data-provider';
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import type {
  Query,
  QueryClient,
  UseQueryOptions,
  QueryObserverResult,
} from '@tanstack/react-query';
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

/**
 * How long a prefetched payload counts as the view's own first load. The view mounts a moment
 * after the route starts the prefetch; past this window a mount reconciles as usual.
 */
const PREFETCH_FRESH_MS = 10_000;

/** Conversations whose messages the route prefetched and no view has mounted on yet. */
const prefetched = new Set<string>();

/**
 * The `[messages, id]` query function. The conversation view and the route-level prefetch share
 * it, so a prefetched payload goes through the same reply-fetch bookkeeping and stream guards as
 * a load the view starts itself.
 */
export async function loadConversationMessages(
  queryClient: QueryClient,
  id: string,
  { pathname, isStreaming }: { pathname: string; isStreaming: () => boolean },
): Promise<t.TMessage[]> {
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

    const hasLiveStream = isStreaming() || hasActiveJob(queryClient, id);
    if (
      currentMessages &&
      isNotFoundError(error) &&
      shouldPreserveMessagesOnNotFound({
        pathname: pathname,
        currentMessages,
        isStreaming: hasLiveStream,
      })
    ) {
      logger.warn(
        'messages',
        `Messages query for convo ${id} returned 404 while cache has a pending assistant tail; path: "${pathname}"`,
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
    pathname: pathname,
    result,
    currentMessages,
    isStreaming: isStreaming() || hasActiveJob(queryClient, id),
  });

  if (stableMessages === currentMessages) {
    logger.warn(
      'messages',
      `Messages query for convo ${id} returned fewer than cache; path: "${pathname}"`,
      result,
      currentMessages,
    );
  }

  completeMessagesReplyFetch(queryClient, id, request, stableMessages === result);
  return stableMessages;
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

  const query = useQuery<t.TMessage[], unknown, TData>(
    [QueryKeys.messages, id],
    () =>
      loadConversationMessages(queryClient, id, {
        pathname: location.pathname,
        isStreaming: () => isStreamingRef.current,
      }),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );

  /** Runs after the query subscribed, so the mount above already decided on the prefetch. */
  useEffect(() => {
    prefetched.delete(id);
  }, [id]);

  return query;
};

/**
 * Starts loading a conversation's messages as soon as the route knows its id, instead of when the
 * conversation view mounts after config, roles, endpoints, models and the conversation itself
 * have resolved. Only a conversation the cache has never held is prefetched, so in-app navigation
 * and warm caches keep their existing behavior. A failed prefetch leaves no data, and the view's
 * own query then loads and reports the error as before.
 */
export function usePrefetchConversationMessages(conversationId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const { pathname } = useLocation();
  const pathnameRef = useRef(pathname);

  useLayoutEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (
      !enabled ||
      !conversationId ||
      conversationId === Constants.NEW_CONVO ||
      conversationId === Constants.SEARCH
    ) {
      return;
    }
    const queryKey = [QueryKeys.messages, conversationId];
    if (queryClient.getQueryState(queryKey) != null) {
      return;
    }
    prefetched.add(conversationId);
    queryClient
      .prefetchQuery(
        queryKey,
        () =>
          loadConversationMessages(queryClient, conversationId, {
            pathname: pathnameRef.current,
            isStreaming: () => false,
          }),
        { retry: false },
      )
      .then(() => {
        if (queryClient.getQueryState(queryKey)?.status !== 'success') {
          prefetched.delete(conversationId);
        }
      });
  }, [conversationId, enabled, queryClient]);
}

/**
 * `refetchOnMount` for the conversation view: a mount on a payload the route just prefetched uses
 * it instead of loading the same messages a second time. Any other mount, or a payload something
 * has since replaced, refetches as before. React Query evaluates this more than once per mount, so
 * it only reads; `useGetMessagesByConvoId` clears the mark once its view has mounted.
 */
export function refetchMessagesOnMount(query: Query<t.TMessage[], unknown>): boolean {
  const conversationId = query.queryKey[1];
  if (typeof conversationId !== 'string' || !prefetched.has(conversationId)) {
    return true;
  }
  /** The route prefetches only a conversation the cache has never held, so a second write means
   *  something newer replaced the prefetched payload. */
  const { dataUpdateCount, dataUpdatedAt } = query.state;
  return !(dataUpdateCount === 1 && Date.now() - dataUpdatedAt < PREFETCH_FRESH_MS);
}

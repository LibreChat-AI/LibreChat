import { useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  QueryKeys,
  dataService,
  EModelEndpoint,
  isAgentsEndpoint,
  defaultOrderQuery,
  defaultAssistantsVersion,
} from 'librechat-data-provider';
import type {
  Action,
  TPreset,
  ConversationListResponse,
  ConversationListParams,
  MessagesListParams,
  MessagesListResponse,
  Assistant,
  AssistantListParams,
  AssistantListResponse,
  AssistantDocument,
  TEndpointsConfig,
  TCheckUserKeyResponse,
  SharedLinksListParams,
  SharedLinksResponse,
} from 'librechat-data-provider';
import type {
  UseInfiniteQueryOptions,
  QueryObserverResult,
  UseQueryOptions,
  InfiniteData,
} from '@tanstack/react-query';
import type t from 'librechat-data-provider';
import type { ConversationCursorData } from '~/utils/convos';
import { findConversationInInfinite, isNotFoundError } from '~/utils';

export const useGetPresetsQuery = (
  config?: UseQueryOptions<TPreset[]>,
): QueryObserverResult<TPreset[], unknown> => {
  return useQuery<TPreset[]>([QueryKeys.presets], () => dataService.getPresets(), {
    staleTime: 1000 * 10,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    ...config,
  });
};

export const useGetConvoIdQuery = (
  id: string,
  config?: UseQueryOptions<t.TConversation>,
): QueryObserverResult<t.TConversation> => {
  const queryClient = useQueryClient();

  return useQuery<t.TConversation>(
    [QueryKeys.conversation, id],
    () => {
      // Try to find in all fetched infinite pages
      const convosQuery = queryClient.getQueryData<InfiniteData<ConversationCursorData>>(
        [QueryKeys.allConversations],
        { exact: false },
      );
      const found = findConversationInInfinite(convosQuery, id);

      if (found && found.messages != null) {
        return found;
      }
      // Otherwise, fetch from API
      return dataService.getConversationById(id);
    },
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: (failureCount, error) => {
        if (isNotFoundError(error)) {
          return false;
        }
        return failureCount < 3;
      },
      ...config,
    },
  );
};

export const useConversationsInfiniteQuery = (
  params: ConversationListParams,
  config?: UseInfiniteQueryOptions<ConversationListResponse, unknown>,
) => {
  const { isArchived, sortBy, sortDirection, tags, search, projectId } = params;

  return useInfiniteQuery<ConversationListResponse>({
    queryKey: [
      isArchived ? QueryKeys.archivedConversations : QueryKeys.allConversations,
      { isArchived, sortBy, sortDirection, tags, search, projectId },
    ],
    queryFn: async ({ pageParam }) => {
      const page = await dataService.listConversations({
        isArchived,
        sortBy,
        sortDirection,
        tags,
        search,
        projectId,
        cursor: pageParam?.toString(),
      });
      /* A row's own `isArchived` decides what its menu offers, so a backend that predates
         that field in the list projection would make archived rows offer Archive and submit
         a no-op. What the variant asked for is the answer for any row that omits it. */
      return {
        ...page,
        conversations: page.conversations.map((conversation) =>
          conversation.isArchived == null
            ? { ...conversation, isArchived: isArchived === true }
            : conversation,
        ),
      };
    },
    getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
    keepPreviousData: true,
    staleTime: 5 * 60 * 1000, // 5 minutes
    cacheTime: 30 * 60 * 1000, // 30 minutes
    ...config,
  });
};

/**
 * Pinned chats are a hand-curated set, so the sidebar fetches the whole thing rather
 * than paginating it: a pin older than the first page of the Chats list would
 * otherwise stay hidden until that list scrolled far enough to reach it, and
 * `groupConversations` keeps pins out of the Chats groups entirely, so any pin
 * this query does not return is invisible in the sidebar. The page size is therefore a
 * request size, not a cap; the query drains the cursor.
 *
 * It takes no filters on purpose: the Chats list's status, bookmark and sort choices
 * narrow that list alone, and a curated shortcut row that emptied itself whenever a
 * filter was on would be the opposite of a shortcut.
 */
export const pinnedConversationsPageSize = 100;

export const usePinnedConversationsQuery = (
  config?: UseQueryOptions<ConversationListResponse>,
): QueryObserverResult<ConversationListResponse> => {
  const queryClient = useQueryClient();
  const queryKey = [QueryKeys.pinnedConversations];

  return useQuery<ConversationListResponse>(
    queryKey,
    async ({ signal }) => {
      const conversations: ConversationListResponse['conversations'] = [];
      let cursor: string | undefined;

      do {
        let page: ConversationListResponse;
        try {
          page = await dataService.listConversations({
            pinned: true,
            limit: pinnedConversationsPageSize,
            cursor,
          });
        } catch (error) {
          signal?.throwIfAborted();
          /** A page failing partway through the drain must not throw away the pins
           * already loaded: publish them so the retry, which starts the drain over,
           * renders against the partial set instead of an empty section. */
          if (conversations.length > 0) {
            queryClient.setQueryData<ConversationListResponse>(queryKey, {
              conversations,
              nextCursor: cursor ?? null,
            });
          }
          throw error;
        }
        signal?.throwIfAborted();
        conversations.push(...page.conversations);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      return { conversations, nextCursor: null };
    },
    {
      /* Left on the React Query defaults for focus and reconnect, matching the
         conversations query: a pin changed in another tab is only reconciled by a
         refetch, since the mutation that made it never touched this cache. */
      staleTime: 5 * 60 * 1000,
      cacheTime: 30 * 60 * 1000,
      ...config,
    },
  );
};

export const useMessagesInfiniteQuery = (
  params: MessagesListParams,
  config?: UseInfiniteQueryOptions<MessagesListResponse, unknown>,
) => {
  const { sortBy, sortDirection, pageSize, conversationId, messageId, search } = params;

  return useInfiniteQuery<MessagesListResponse>({
    queryKey: [
      QueryKeys.messages,
      { sortBy, sortDirection, pageSize, conversationId, messageId, search },
    ],
    queryFn: ({ pageParam }) =>
      dataService.listMessages({
        sortBy,
        sortDirection,
        pageSize,
        conversationId,
        messageId,
        search,
        cursor: pageParam?.toString(),
      }),
    getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
    keepPreviousData: true,
    staleTime: 5 * 60 * 1000, // 5 minutes
    cacheTime: 30 * 60 * 1000, // 30 minutes
    ...config,
  });
};

export const useSharedLinksQuery = (
  params: SharedLinksListParams,
  config?: UseInfiniteQueryOptions<SharedLinksResponse, unknown>,
) => {
  const { pageSize, search, sortBy, sortDirection } = params;

  return useInfiniteQuery<SharedLinksResponse>({
    queryKey: [QueryKeys.sharedLinks, { pageSize, search, sortBy, sortDirection }],
    queryFn: ({ pageParam }) =>
      dataService.listSharedLinks({
        cursor: pageParam?.toString(),
        pageSize,
        search,
        sortBy,
        sortDirection,
      }),
    getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
    keepPreviousData: true,
    staleTime: 5 * 60 * 1000, // 5 minutes
    cacheTime: 30 * 60 * 1000, // 30 minutes
    ...config,
  });
};

export const useConversationTagsQuery = (
  config?: UseQueryOptions<t.TConversationTagsResponse>,
): QueryObserverResult<t.TConversationTagsResponse> => {
  return useQuery<t.TConversationTag[]>(
    [QueryKeys.conversationTags],
    () => dataService.getConversationTags(),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );
};

/**
 * ASSISTANTS
 */

/**
 * Hook for getting available LibreChat tools (excludes MCP tools)
 * For MCP tools, use `useMCPToolsQuery` from mcp-queries.ts
 */
export const useAvailableToolsQuery = <TData = t.TPlugin[]>(
  endpoint: t.AssistantsEndpoint | EModelEndpoint.agents,
  config?: UseQueryOptions<t.TPlugin[], unknown, TData>,
): QueryObserverResult<TData> => {
  const queryClient = useQueryClient();
  const endpointsConfig = queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]);
  const keyExpiry = queryClient.getQueryData<TCheckUserKeyResponse>([QueryKeys.name, endpoint]);
  const userProvidesKey = !!endpointsConfig?.[endpoint]?.userProvide;
  const keyProvided = userProvidesKey ? !!keyExpiry?.expiresAt : true;
  const enabled = isAgentsEndpoint(endpoint) ? true : !!endpointsConfig?.[endpoint] && keyProvided;
  const version: string | number | undefined =
    endpointsConfig?.[endpoint]?.version ?? defaultAssistantsVersion[endpoint];
  return useQuery<t.TPlugin[], unknown, TData>(
    [QueryKeys.tools],
    () => dataService.getAvailableTools(endpoint, version),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      enabled,
      ...config,
    },
  );
};

/**
 * Hook for listing all assistants, with optional parameters provided for pagination and sorting
 */
export const useListAssistantsQuery = <TData = AssistantListResponse>(
  endpoint: t.AssistantsEndpoint,
  params: Omit<AssistantListParams, 'endpoint'> = defaultOrderQuery,
  config?: UseQueryOptions<AssistantListResponse, unknown, TData>,
): QueryObserverResult<TData> => {
  const queryClient = useQueryClient();
  const endpointsConfig = queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]);
  const keyExpiry = queryClient.getQueryData<TCheckUserKeyResponse>([QueryKeys.name, endpoint]);
  const userProvidesKey = !!(endpointsConfig?.[endpoint]?.userProvide ?? false);
  const keyProvided = userProvidesKey ? !!(keyExpiry?.expiresAt ?? '') : true;
  const enabled = !!endpointsConfig?.[endpoint] && keyProvided;
  const version = endpointsConfig?.[endpoint]?.version ?? defaultAssistantsVersion[endpoint];
  return useQuery<AssistantListResponse, unknown, TData>(
    [QueryKeys.assistants, endpoint, params],
    () => dataService.listAssistants({ ...params, endpoint }, version),
    {
      // Example selector to sort them by created_at
      // select: (res) => {
      //   return res.data.sort((a, b) => a.created_at - b.created_at);
      // },
      staleTime: 1000 * 5,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: false,
      ...config,
      enabled: config?.enabled !== undefined ? config.enabled && enabled : enabled,
    },
  );
};

/*
export const useListAssistantsInfiniteQuery = (
  params?: AssistantListParams,
  config?: UseInfiniteQueryOptions<AssistantListResponse, Error>,
) => {
  const queryClient = useQueryClient();
  const endpointsConfig = queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]);
  const keyExpiry = queryClient.getQueryData<TCheckUserKeyResponse>([
    QueryKeys.name,
    EModelEndpoint.assistants,
  ]);
  const userProvidesKey = !!endpointsConfig?.[EModelEndpoint.assistants]?.userProvide;
  const keyProvided = userProvidesKey ? !!keyExpiry?.expiresAt : true;
  const enabled = !!endpointsConfig?.[EModelEndpoint.assistants] && keyProvided;
  return useInfiniteQuery<AssistantListResponse, Error>(
    ['assistantsList', params],
    ({ pageParam = '' }) => dataService.listAssistants({ ...params, after: pageParam }),
    {
      getNextPageParam: (lastPage) => {
        // lastPage is of type AssistantListResponse, you can use the has_more and last_id from it directly
        if (lastPage.has_more) {
          return lastPage.last_id;
        }
        return undefined;
      },
      ...config,
      enabled: config?.enabled !== undefined ? config?.enabled && enabled : enabled,
    },
  );
};
*/

/**
 * Hook for retrieving details about a single assistant
 */
export const useGetAssistantByIdQuery = (
  endpoint: t.AssistantsEndpoint,
  assistant_id: string,
  config?: UseQueryOptions<Assistant>,
): QueryObserverResult<Assistant> => {
  const queryClient = useQueryClient();
  const endpointsConfig = queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]);
  const keyExpiry = queryClient.getQueryData<TCheckUserKeyResponse>([QueryKeys.name, endpoint]);
  const userProvidesKey = endpointsConfig?.[endpoint]?.userProvide ?? false;
  const keyProvided = userProvidesKey ? !!keyExpiry?.expiresAt : true;
  const enabled = !!endpointsConfig?.[endpoint] && keyProvided;
  const version = endpointsConfig?.[endpoint]?.version ?? defaultAssistantsVersion[endpoint];
  return useQuery<Assistant>(
    [QueryKeys.assistant, assistant_id],
    () =>
      dataService.getAssistantById({
        endpoint,
        assistant_id,
        version,
      }),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: false,
      ...config,
      // Query will not execute until the assistant_id exists
      enabled: config?.enabled !== undefined ? config.enabled && enabled : enabled,
    },
  );
};

/**
 * Hook for retrieving user's saved Assistant Actions
 */
export const useGetActionsQuery = <TData = Action[]>(
  endpoint: t.AssistantsEndpoint | EModelEndpoint.agents,
  config?: UseQueryOptions<Action[], unknown, TData>,
): QueryObserverResult<TData> => {
  const queryClient = useQueryClient();
  const endpointsConfig = queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]);
  const keyExpiry = queryClient.getQueryData<TCheckUserKeyResponse>([QueryKeys.name, endpoint]);
  const userProvidesKey = !!endpointsConfig?.[endpoint]?.userProvide;
  const keyProvided = userProvidesKey ? !!keyExpiry?.expiresAt : true;
  const enabled =
    (!!endpointsConfig?.[endpoint] && keyProvided) || endpoint === EModelEndpoint.agents;

  return useQuery<Action[], unknown, TData>([QueryKeys.actions], () => dataService.getActions(), {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    ...config,
    enabled: config?.enabled !== undefined ? config.enabled && enabled : enabled,
  });
};

/**
 * Hook for retrieving user's saved Assistant Documents (metadata saved to Database)
 */
export const useGetAssistantDocsQuery = <TData = AssistantDocument[]>(
  endpoint: t.AssistantsEndpoint | string,
  config?: UseQueryOptions<AssistantDocument[], unknown, TData>,
): QueryObserverResult<TData> => {
  const queryClient = useQueryClient();
  const endpointsConfig = queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]);
  const keyExpiry = queryClient.getQueryData<TCheckUserKeyResponse>([QueryKeys.name, endpoint]);
  const userProvidesKey = !!(endpointsConfig?.[endpoint]?.userProvide ?? false);
  const keyProvided = userProvidesKey ? !!(keyExpiry?.expiresAt ?? '') : true;
  const enabled = !!endpointsConfig?.[endpoint] && keyProvided;
  const version = endpointsConfig?.[endpoint]?.version ?? defaultAssistantsVersion[endpoint];

  return useQuery<AssistantDocument[], unknown, TData>(
    [QueryKeys.assistantDocs, endpoint],
    () =>
      dataService.getAssistantDocs({
        endpoint,
        version,
      }),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
      enabled: config?.enabled !== undefined ? config.enabled && enabled : enabled,
    },
  );
};

/** STT/TTS */

/* Text to speech voices */
export const useVoicesQuery = (
  config?: UseQueryOptions<t.VoiceResponse>,
): QueryObserverResult<t.VoiceResponse> => {
  return useQuery<t.VoiceResponse>([QueryKeys.voices], () => dataService.getVoices(), {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: false,
    ...config,
  });
};

/* Custom config speech */
export const useCustomConfigSpeechQuery = (
  config?: UseQueryOptions<t.TCustomConfigSpeechResponse>,
): QueryObserverResult<t.TCustomConfigSpeechResponse> => {
  return useQuery<t.TCustomConfigSpeechResponse>(
    [QueryKeys.customConfigSpeech],
    () => dataService.getCustomConfigSpeech(),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: false,
      ...config,
    },
  );
};

/** Prompt */

export const usePromptGroupsInfiniteQuery = (
  params?: t.TPromptGroupsWithFilterRequest,
  config?: UseInfiniteQueryOptions<t.PromptGroupListResponse, unknown>,
) => {
  const { name, pageSize, category } = params || {};
  return useInfiniteQuery<t.PromptGroupListResponse, unknown>(
    [QueryKeys.promptGroups, name, category, pageSize],
    ({ pageParam }) => {
      const queryParams: t.TPromptGroupsWithFilterRequest = {
        name,
        category: category || '',
        limit: (pageSize || 10).toString(),
      };

      // Only add cursor if it's a valid string
      if (pageParam && typeof pageParam === 'string') {
        queryParams.cursor = pageParam;
      }

      return dataService.getPromptGroups(queryParams);
    },
    {
      getNextPageParam: (lastPage) => {
        // Use cursor-based pagination - ensure we return a valid cursor or undefined
        return lastPage.has_more && lastPage.after ? lastPage.after : undefined;
      },
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );
};

export const useGetPromptGroup = (
  id: string,
  config?: UseQueryOptions<t.TPromptGroup>,
): QueryObserverResult<t.TPromptGroup> => {
  return useQuery<t.TPromptGroup>(
    [QueryKeys.promptGroup, id],
    () => dataService.getPromptGroup(id),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: false,
      ...config,
      enabled: config?.enabled !== undefined ? config.enabled : true,
    },
  );
};

export const useGetPrompts = (
  filter: t.TPromptsWithFilterRequest,
  config?: UseQueryOptions<t.TPrompt[]>,
): QueryObserverResult<t.TPrompt[]> => {
  return useQuery<t.TPrompt[]>(
    [QueryKeys.prompts, filter.groupId ?? ''],
    () => dataService.getPrompts(filter),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: false,
      ...config,
      enabled: config?.enabled !== undefined ? config.enabled : true,
    },
  );
};

export const useGetAllPromptGroups = <TData = t.AllPromptGroupsResponse>(
  filter?: t.AllPromptGroupsFilterRequest,
  config?: UseQueryOptions<t.AllPromptGroupsResponse, unknown, TData>,
): QueryObserverResult<TData> => {
  return useQuery<t.AllPromptGroupsResponse, unknown, TData>(
    [QueryKeys.allPromptGroups],
    () => dataService.getAllPromptGroups(),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: false,
      ...config,
    },
  );
};

export const useGetCategories = <TData = t.TGetCategoriesResponse>(
  config?: UseQueryOptions<t.TGetCategoriesResponse, unknown, TData>,
): QueryObserverResult<TData> => {
  return useQuery<t.TGetCategoriesResponse, unknown, TData>(
    [QueryKeys.categories],
    () => dataService.getCategories(),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: false,
      ...config,
      enabled: config?.enabled !== undefined ? config.enabled : true,
    },
  );
};

export const useGetRandomPrompts = (
  filter: t.TGetRandomPromptsRequest,
  config?: UseQueryOptions<t.TGetRandomPromptsResponse>,
): QueryObserverResult<t.TGetRandomPromptsResponse> => {
  return useQuery<t.TGetRandomPromptsResponse>(
    [QueryKeys.randomPrompts],
    () => dataService.getRandomPrompts(filter),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: false,
      ...config,
      enabled: config?.enabled !== undefined ? config.enabled : true,
    },
  );
};

export const useUserTermsQuery = (
  config?: UseQueryOptions<t.TUserTermsResponse>,
): QueryObserverResult<t.TUserTermsResponse> => {
  return useQuery<t.TUserTermsResponse>([QueryKeys.userTerms], () => dataService.getUserTerms(), {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    ...config,
  });
};

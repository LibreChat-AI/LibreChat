import { useRef, useMemo, useEffect, useCallback } from 'react';
import { QueryKeys, dataService, EModelEndpoint, PermissionBits } from 'librechat-data-provider';
import {
  useQuery,
  useInfiniteQuery,
  useQueryClient,
  replaceEqualDeep,
} from '@tanstack/react-query';
import type {
  QueryObserverResult,
  UseQueryOptions,
  UseInfiniteQueryOptions,
  InfiniteData,
  UseInfiniteQueryResult,
  QueryClient,
  QueryKey,
} from '@tanstack/react-query';
import type t from 'librechat-data-provider';
import { retryTransientQuery } from '../retry';
import { isEphemeralAgent } from '~/common';

/**
 * AGENTS
 */
export const defaultAgentParams: t.AgentListParams = {
  requiredPermission: PermissionBits.EDIT,
};

/** Bound the first response; later pages populate the same catalog incrementally. */
const CATALOG_PAGE_SIZE = 100;

/**
 * A cursor is bound to the sort/filter request that produced it. During a rolling
 * deploy, an old page can therefore be rejected by the newer server; that is a
 * recoverable mixed-version condition, not a list failure to show the user.
 */
const isCursorOrderingMismatch = (error: unknown): boolean => {
  if (
    error == null ||
    typeof error !== 'object' ||
    !('response' in error) ||
    error.response == null ||
    typeof error.response !== 'object' ||
    !('status' in error.response) ||
    error.response.status !== 409 ||
    !('data' in error.response) ||
    error.response.data == null ||
    typeof error.response.data !== 'object' ||
    !('error' in error.response.data)
  ) {
    return false;
  }
  return error.response.data.error === 'cursor_ordering_mismatch';
};

/**
 * Hook for getting all available tools for A
 */
export const useAvailableAgentToolsQuery = (): QueryObserverResult<t.TPlugin[]> => {
  const queryClient = useQueryClient();
  const endpointsConfig = queryClient.getQueryData<t.TEndpointsConfig>([QueryKeys.endpoints]);

  const enabled = !!endpointsConfig?.[EModelEndpoint.agents];
  return useQuery<t.TPlugin[]>([QueryKeys.tools], () => dataService.getAvailableAgentTools(), {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    enabled,
  });
};

export type AgentListCache = t.AgentListResponse | InfiniteData<t.AgentListResponse>;

const flattenAgentList = (response: AgentListCache): t.AgentListResponse => {
  if (!('pages' in response)) {
    return response;
  }
  const first = response.pages[0];
  const last = response.pages[response.pages.length - 1];
  return {
    object: first?.object ?? 'list',
    data: response.pages.flatMap((page) => page.data),
    first_id: first?.first_id ?? '',
    last_id: last?.last_id ?? '',
    has_more: !!last?.after,
    after: last?.after,
  };
};

export const getAgentListQueryData = (queryClient: QueryClient, queryKey: QueryKey) => {
  const cached = queryClient.getQueryData<AgentListCache>(queryKey);
  return cached ? flattenAgentList(cached) : undefined;
};

/** Apply existing list mutations without losing loaded pages or their continuation cursors. */
export const setAgentListQueryData = (
  queryClient: QueryClient,
  queryKey: QueryKey,
  update:
    | t.AgentListResponse
    | ((previous: t.AgentListResponse | undefined) => t.AgentListResponse | undefined),
) => {
  queryClient.setQueryData<AgentListCache>(queryKey, (cached) => {
    const next = typeof update === 'function' ? update(cached && flattenAgentList(cached)) : update;
    if (!next || !cached || !('pages' in cached)) {
      return next;
    }
    const byId = new Map(next.data.map((agent) => [agent.id, agent]));
    const loadedIds = new Set(cached.pages.flatMap((page) => page.data.map((agent) => agent.id)));
    const added = next.data.filter((agent) => !loadedIds.has(agent.id));
    return {
      ...cached,
      pages: cached.pages.map((page, index) => {
        const data = index === 0 ? [...added] : [];
        for (const agent of page.data) {
          const updated = byId.get(agent.id);
          if (updated) {
            data.push(updated);
          }
        }
        return { ...page, data, first_id: data[0]?.id ?? '', last_id: data.at(-1)?.id ?? '' };
      }),
    };
  });
};

/** The cache key stays shared with agent mutations and every catalog observer. */
export const useListAgentsInfiniteQuery = (
  params: t.AgentListParams = defaultAgentParams,
  config?: UseInfiniteQueryOptions<t.AgentListResponse>,
): UseInfiniteQueryResult<t.AgentListResponse> => {
  const { data: endpointsConfig } = useQuery<t.TEndpointsConfig>(
    [QueryKeys.endpoints],
    () => dataService.getAIEndpoints(),
    { enabled: false },
  );
  return useInfiniteQuery<t.AgentListResponse>({
    staleTime: 1000 * 5,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
    retry: retryTransientQuery,
    ...config,
    queryKey: [QueryKeys.agents, params],
    queryFn: ({ pageParam }) =>
      dataService.listAgents({
        ...params,
        limit: params.limit ?? CATALOG_PAGE_SIZE,
        cursor: pageParam ?? params.cursor,
      }),
    getNextPageParam: (lastPage) => lastPage?.after || undefined,
    enabled: !!endpointsConfig?.[EModelEndpoint.agents] && (config?.enabled ?? true),
  });
};

export type AgentListQueryOptions<TData> = Omit<
  UseInfiniteQueryOptions<t.AgentListResponse>,
  'select' | 'onSuccess' | 'onSettled'
> & {
  select?: (response: t.AgentListResponse) => TData;
  onSuccess?: (response: TData) => void;
  onSettled?: (response: TData | undefined, error: unknown) => void;
};

export type AgentCatalogQueryResult<TData> = Omit<
  UseInfiniteQueryResult<t.AgentListResponse>,
  'data' | 'refetch'
> & {
  data: TData | undefined;
  refetch: () => Promise<QueryObserverResult<TData>>;
  isComplete: boolean;
};

/** Publish each page immediately, and stop automatic pagination on an error until retry. */
export const useListAgentsQuery = <TData = t.AgentListResponse>(
  params: t.AgentListParams = defaultAgentParams,
  config?: AgentListQueryOptions<TData>,
): AgentCatalogQueryResult<TData> => {
  const queryClient = useQueryClient();
  const selectResponse = config?.select;
  const select = useCallback(
    (response: AgentListCache): TData => {
      const flattened = flattenAgentList(response);
      return selectResponse ? selectResponse(flattened) : (flattened as TData);
    },
    [selectResponse],
  );
  const { select: _select, onSuccess, onSettled, ...options } = config ?? {};
  const query = useListAgentsInfiniteQuery(params, {
    ...options,
    onSuccess: onSuccess ? (response) => onSuccess(select(response)) : undefined,
    onSettled: onSettled
      ? (response, error) => onSettled(response ? select(response) : undefined, error)
      : undefined,
  });
  const { fetchNextPage, hasNextPage, isFetching, isError } = query;
  useEffect(() => {
    if (config?.enabled !== false && hasNextPage && !isFetching && !isError) {
      void fetchNextPage({ cancelRefetch: false });
    }
  }, [config?.enabled, fetchNextPage, hasNextPage, isFetching, isError]);

  const previous = useRef<TData>();
  const data = useMemo(() => {
    const next = query.data ? select(query.data) : undefined;
    previous.current = replaceEqualDeep(previous.current, next);
    return previous.current;
  }, [query.data, select]);
  const refetchQuery = query.refetch;
  const refetch = useCallback(async (): Promise<QueryObserverResult<TData>> => {
    const fetchMeta: { fetchMore?: { direction?: string } } | undefined = queryClient.getQueryState(
      [QueryKeys.agents, params],
    )?.fetchMeta;
    const nextPageFailed = query.isError && fetchMeta?.fetchMore?.direction === 'forward';
    const result = nextPageFailed ? await fetchNextPage() : await refetchQuery();
    return {
      ...result,
      data: result.data ? select(result.data) : undefined,
      refetch,
    } as QueryObserverResult<TData>;
  }, [queryClient, params, query.isError, refetchQuery, fetchNextPage, select]);
  return { ...query, data, refetch, isComplete: query.data != null && !hasNextPage && !isError };
};

/**
 * Hook for retrieving basic details about a single agent (VIEW permission)
 */
export const useGetAgentByIdQuery = (
  agent_id: string | null | undefined,
  config?: UseQueryOptions<t.Agent>,
): QueryObserverResult<t.Agent> => {
  const isValidAgentId = !!agent_id && !isEphemeralAgent(agent_id);

  return useQuery<t.Agent>(
    [QueryKeys.agent, agent_id],
    () =>
      dataService.getAgentById({
        agent_id: agent_id as string,
      }),
    {
      staleTime: 1000 * 5,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: true,
      retry: retryTransientQuery,
      ...config,
      enabled: isValidAgentId && (config?.enabled ?? true),
    },
  );
};

/**
 * Hook for retrieving full agent details including sensitive configuration (EDIT permission)
 */
export const useGetExpandedAgentByIdQuery = (
  agent_id: string,
  config?: UseQueryOptions<t.Agent>,
): QueryObserverResult<t.Agent> => {
  return useQuery<t.Agent>(
    [QueryKeys.agent, agent_id, 'expanded'],
    () =>
      dataService.getExpandedAgentById({
        agent_id,
      }),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: false,
      ...config,
    },
  );
};

/**
 * Hook for lazily retrieving an agent's version history (EDIT permission).
 * Only fetched when the user opens version history, so editors with large
 * histories don't pay the cost on every open.
 */
export const useGetAgentVersionsQuery = (
  agent_id: string | null | undefined,
  config?: UseQueryOptions<t.Agent[]>,
): QueryObserverResult<t.Agent[]> => {
  const isValidAgentId = !!agent_id && !isEphemeralAgent(agent_id);

  return useQuery<t.Agent[]>(
    [QueryKeys.agent, agent_id, 'versions'],
    () =>
      dataService.getAgentVersions({
        agent_id: agent_id as string,
      }),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
      ...config,
      enabled: isValidAgentId && (config?.enabled ?? true),
    },
  );
};

/**
 * MARKETPLACE
 */
/**
 * Hook for getting agent categories for marketplace tabs
 */
export const useGetAgentCategoriesQuery = (
  config?: UseQueryOptions<t.TMarketplaceCategory[]>,
): QueryObserverResult<t.TMarketplaceCategory[]> => {
  return useQuery<t.TMarketplaceCategory[]>(
    [QueryKeys.agentCategories],
    () => dataService.getAgentCategories(),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      staleTime: 5 * 60 * 1000, // Cache for 5 minutes
      ...config,
    },
  );
};

/**
 * Hook for infinite loading of marketplace agents with cursor-based pagination
 */
type MarketplaceCursorRecovery = {
  id: number;
  status: 'resetting' | 'succeeded';
};

/** The bounded whole-walk recovery state exposed to consumers that hold page failures. */
export type MarketplaceCursorRecoverySignal = MarketplaceCursorRecovery | null;

export const useMarketplaceAgentsInfiniteQuery = (
  params: t.AgentListParams,
  config?: UseInfiniteQueryOptions<t.AgentListResponse, unknown>,
) => {
  const queryClient = useQueryClient();
  const queryKey = [QueryKeys.marketplaceAgents, params] as const;
  const requestSignature = JSON.stringify(params);
  const mismatchRecovery = useRef<{ signature: string; attempted: boolean }>({
    signature: requestSignature,
    attempted: false,
  });
  const cursorRecoveryRef = useRef<MarketplaceCursorRecoverySignal>(null);
  const cursorRecoveryIdRef = useRef(0);
  if (mismatchRecovery.current.signature !== requestSignature) {
    mismatchRecovery.current = { signature: requestSignature, attempted: false };
    cursorRecoveryRef.current = null;
  }

  const onError = (error: unknown) => {
    if (
      isCursorOrderingMismatch(error) &&
      mismatchRecovery.current.signature === requestSignature &&
      !mismatchRecovery.current.attempted
    ) {
      mismatchRecovery.current.attempted = true;
      const recoveryId = ++cursorRecoveryIdRef.current;
      cursorRecoveryRef.current = { id: recoveryId, status: 'resetting' };
      /*
       * `fetchNextPage` normally preserves old pages and appends its result. Resetting
       * this exact query first discards the foreign-ordered prefix; the active observer
       * then refetches page one with no cursor. The per-signature guard makes a server
       * that keeps returning 409 surface one ordinary error instead of looping forever.
       */
      void queryClient.resetQueries({ queryKey, exact: true });
    }
    config?.onError?.(error);
  };

  const query = useInfiniteQuery<t.AgentListResponse>({
    queryKey,
    queryFn: ({ pageParam }) => {
      const queryParams = { ...params };
      if (pageParam) {
        queryParams.cursor = pageParam.toString();
      }
      return dataService.getMarketplaceAgents(queryParams);
    },
    getNextPageParam: (lastPage) => lastPage?.after ?? undefined,
    enabled: !!params.requiredPermission,
    keepPreviousData: true,
    staleTime: 2 * 60 * 1000, // 2 minutes
    cacheTime: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: false,
    // An errored list has no data, so it is stale: regaining connectivity
    // refetches it instead of leaving the user on a terminal error card.
    refetchOnReconnect: true,
    /**
     * 4xx answers are deterministic, so only transport and server failures are
     * worth repeating, and only briefly — the error card owns the long backoff,
     * and every second spent retrying inside the query is a second the user
     * stares at a skeleton with no way to intervene.
     */
    retry: (failureCount, error) => {
      if (failureCount >= 2) {
        return false;
      }
      const status = (error as { response?: { status?: number } } | null)?.response?.status;
      if (status != null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        return false;
      }
      return true;
    },
    retryDelay: (failureCount) => Math.min(500 * 2 ** failureCount, 2000),
    // Revisit invalidated popularity pages without reordering the active list after a pin.
    refetchOnMount: true,
    ...config,
    onError,
  });
  /*
   * `resetQueries` restarts this infinite query with its initial page. Observe the
   * settled one-page result here so consumers can distinguish that successful walk
   * reset from an ordinary cursor-page failure, even when the replacement walk is
   * shorter than the discarded prefix.
   */
  if (
    cursorRecoveryRef.current?.status === 'resetting' &&
    query.status === 'success' &&
    !query.isFetching &&
    query.data?.pages.length === 1
  ) {
    cursorRecoveryRef.current = { ...cursorRecoveryRef.current, status: 'succeeded' };
  }
  return { ...query, cursorRecovery: cursorRecoveryRef.current };
};

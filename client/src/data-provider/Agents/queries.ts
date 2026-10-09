import { useRef } from 'react';
import { useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, dataService, EModelEndpoint, PermissionBits } from 'librechat-data-provider';
import type {
  QueryObserverResult,
  UseQueryOptions,
  UseInfiniteQueryOptions,
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

/**
 * Page size for the internal pagination walk. Callers consume the flattened result, so
 * every page costs a serial round trip with no benefit: request the server's maximum
 * (`getListAgentsByAccess` caps at 1000) so realistic agent sets resolve in one request.
 * Kept out of the query key, and applied last so a caller-supplied `limit` cannot shrink
 * it: this is a transport detail, and a caller limit never bounds what the walk returns.
 */
const WALK_PAGE_SIZE = 1000;

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

/** Walk the cursor pagination and return all pages flattened into one `AgentListResponse`. */
async function fetchAllAgentPages(params: t.AgentListParams): Promise<t.AgentListResponse> {
  const pages: t.AgentListResponse[] = [];
  let cursor: string | null | undefined = params.cursor;
  do {
    const page = await dataService.listAgents({
      ...params,
      ...(cursor ? { cursor } : {}),
      limit: WALK_PAGE_SIZE,
    });
    pages.push(page);
    cursor = page.after;
  } while (cursor);

  const lastPage = pages[pages.length - 1];
  return {
    object: 'list',
    data: pages.flatMap((p) => p.data),
    has_more: false,
    after: undefined,
    first_id: pages[0]?.first_id ?? '',
    last_id: lastPage?.last_id ?? '',
  };
}

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

/**
 * Hook for listing all Agents the user has access to. Follows cursor
 * pagination internally and resolves with every page concatenated.
 * Cache key shape matches `allAgentViewAndEditQueryKeys` in `./mutations.ts`.
 */
export const useListAgentsQuery = <TData = t.AgentListResponse>(
  params: t.AgentListParams = defaultAgentParams,
  config?: UseQueryOptions<t.AgentListResponse, unknown, TData>,
): QueryObserverResult<TData> => {
  /** The shell owns fetching endpoints. Observe its query, but do not start a second
   * request or couple this shared agent hook to the shell's Recoil gate. */
  const { data: endpointsConfig } = useQuery<t.TEndpointsConfig>(
    [QueryKeys.endpoints],
    () => dataService.getAIEndpoints(),
    { enabled: false },
  );

  const enabled = !!endpointsConfig?.[EModelEndpoint.agents];
  return useQuery<t.AgentListResponse, unknown, TData>(
    [QueryKeys.agents, params],
    () => fetchAllAgentPages(params),
    {
      staleTime: 1000 * 5,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: true,
      retry: retryTransientQuery,
      ...config,
      enabled: config?.enabled !== undefined ? config.enabled && enabled : enabled,
    },
  );
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

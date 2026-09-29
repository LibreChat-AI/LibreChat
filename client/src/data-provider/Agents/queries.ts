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
export const useMarketplaceAgentsInfiniteQuery = (
  params: {
    requiredPermission: number;
    category?: string;
    search?: string;
    limit?: number;
    promoted?: 0 | 1;
    cursor?: string; // For pagination
  },
  config?: UseInfiniteQueryOptions<t.AgentListResponse, unknown>,
) => {
  return useInfiniteQuery<t.AgentListResponse>({
    queryKey: [QueryKeys.marketplaceAgents, params],
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
    refetchOnReconnect: false,
    refetchOnMount: false,
    ...config,
  });
};

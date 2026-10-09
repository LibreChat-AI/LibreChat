import { useQuery } from '@tanstack/react-query';
import { Constants, QueryKeys, dataService } from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';
import type t from 'librechat-data-provider';

export const useVerifyAgentToolAuth = (
  params: t.VerifyToolAuthParams,
  config?: UseQueryOptions<t.VerifyToolAuthResponse>,
): QueryObserverResult<t.VerifyToolAuthResponse> => {
  return useQuery<t.VerifyToolAuthResponse>(
    [QueryKeys.toolAuth, params.toolId],
    () => dataService.getVerifyAgentToolAuth(params),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );
};

export const useGetToolCalls = <TData = t.ToolCallResults>(
  params: t.GetToolCallParams,
  config?: UseQueryOptions<t.ToolCallResults, unknown, TData>,
): QueryObserverResult<TData, unknown> => {
  const { conversationId = '' } = params;
  return useQuery<t.ToolCallResults, unknown, TData>(
    [QueryKeys.toolCalls, conversationId],
    () => dataService.getToolCalls(params),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      enabled:
        conversationId.length > 0 &&
        conversationId !== Constants.NEW_CONVO &&
        conversationId !== Constants.PENDING_CONVO &&
        conversationId !== Constants.SEARCH,
      ...config,
    },
  );
};

export const useMCPConnectionStatusQuery = (
  config?: UseQueryOptions<t.MCPConnectionStatusResponse>,
): QueryObserverResult<t.MCPConnectionStatusResponse> => {
  return useQuery<t.MCPConnectionStatusResponse>(
    [QueryKeys.mcpConnectionStatus],
    () => dataService.getMCPConnectionStatus(),
    {
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: true,
      staleTime: 10000, // 10 seconds
      refetchInterval: false,
      refetchIntervalInBackground: false,
      ...config,
    },
  );
};

export const useMCPAuthValuesQuery = (
  serverName: string,
  config?: UseQueryOptions<t.MCPAuthValuesResponse>,
): QueryObserverResult<t.MCPAuthValuesResponse> => {
  return useQuery<t.MCPAuthValuesResponse>(
    [QueryKeys.mcpAuthValues, serverName],
    () => dataService.getMCPAuthValues(serverName),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      enabled: !!serverName,
      ...config,
    },
  );
};

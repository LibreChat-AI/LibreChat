import { dataService, QueryKeys, ResourceType } from 'librechat-data-provider';
import { useMutation, useQueryClient, UseMutationResult } from '@tanstack/react-query';
import type * as t from 'librechat-data-provider';

/**
 * Hook for creating a new MCP server
 */
export const useCreateMCPServerMutation = (options?: {
  onMutate?: (variables: t.MCPServerCreateParams) => void;
  onSuccess?: (
    data: t.MCPServerDBObjectResponse,
    variables: t.MCPServerCreateParams,
    context: unknown,
  ) => void;
  onError?: (error: Error, variables: t.MCPServerCreateParams, context: unknown) => void;
}): UseMutationResult<t.MCPServerDBObjectResponse, Error, t.MCPServerCreateParams> => {
  const queryClient = useQueryClient();

  return useMutation((data: t.MCPServerCreateParams) => dataService.createMCPServer(data), {
    onMutate: (variables) => options?.onMutate?.(variables),
    onError: (error, variables, context) => options?.onError?.(error, variables, context),
    onSuccess: (newServer, variables, context) => {
      const listRes = queryClient.getQueryData<t.MCPServersListResponse>([QueryKeys.mcpServers]);
      if (listRes) {
        queryClient.setQueryData<t.MCPServersListResponse>([QueryKeys.mcpServers], {
          ...listRes,
          [newServer.serverName!]: newServer,
        });
      }

      queryClient.invalidateQueries([QueryKeys.mcpServers]);
      queryClient.invalidateQueries([QueryKeys.mcpTools]);
      queryClient.invalidateQueries([QueryKeys.mcpAuthValues]);
      queryClient.invalidateQueries([QueryKeys.mcpConnectionStatus]);
      queryClient.invalidateQueries([
        QueryKeys.effectivePermissions,
        'all',
        ResourceType.MCPSERVER,
      ]);

      return options?.onSuccess?.(newServer, variables, context);
    },
  });
};

/**
 * Hook for updating an existing MCP server
 */
export const useUpdateMCPServerMutation = (options?: {
  onMutate?: (variables: { serverName: string; data: t.MCPServerUpdateParams }) => void;
  onSuccess?: (
    data: t.MCPServerDBObjectResponse,
    variables: { serverName: string; data: t.MCPServerUpdateParams },
    context: unknown,
  ) => void;
  onError?: (
    error: Error,
    variables: { serverName: string; data: t.MCPServerUpdateParams },
    context: unknown,
  ) => void;
}): UseMutationResult<
  t.MCPServerDBObjectResponse,
  Error,
  { serverName: string; data: t.MCPServerUpdateParams }
> => {
  const queryClient = useQueryClient();

  return useMutation(
    ({ serverName, data }: { serverName: string; data: t.MCPServerUpdateParams }) =>
      dataService.updateMCPServer(serverName, data),
    {
      onMutate: (variables: { serverName: string; data: t.MCPServerUpdateParams }) =>
        options?.onMutate?.(variables),
      onError: (
        error: Error,
        variables: { serverName: string; data: t.MCPServerUpdateParams },
        context: unknown,
      ) => options?.onError?.(error, variables, context),
      onSuccess: (
        updatedServer: t.MCPServerDBObjectResponse,
        variables: { serverName: string; data: t.MCPServerUpdateParams },
        context: unknown,
      ) => {
        // Update list cache
        const listRes = queryClient.getQueryData<t.MCPServersListResponse>([QueryKeys.mcpServers]);
        if (listRes) {
          const oldServer = listRes[variables.serverName];
          listRes[variables.serverName] = {
            ...updatedServer,
            dbId: updatedServer.dbId ?? oldServer?.dbId,
            consumeOnly: updatedServer.consumeOnly ?? oldServer?.consumeOnly,
          };

          queryClient.setQueryData<t.MCPServersListResponse>([QueryKeys.mcpServers], {
            ...listRes,
          });
        }

        queryClient.setQueryData([QueryKeys.mcpServer, variables.serverName], updatedServer);
        queryClient.invalidateQueries([QueryKeys.mcpServers]);
        queryClient.invalidateQueries([QueryKeys.mcpTools]);
        queryClient.invalidateQueries([QueryKeys.mcpAuthValues]);
        queryClient.invalidateQueries([QueryKeys.mcpConnectionStatus]);

        return options?.onSuccess?.(updatedServer, variables, context);
      },
    },
  );
};

/**
 * Hook for deleting an MCP server
 */
export const useDeleteMCPServerMutation = (options?: {
  onMutate?: (variables: string) => void;
  onSuccess?: (_data: { success: boolean }, variables: string, context: unknown) => void;
  onError?: (error: Error, variables: string, context: unknown) => void;
}): UseMutationResult<{ success: boolean }, Error, string> => {
  const queryClient = useQueryClient();

  return useMutation((serverName: string) => dataService.deleteMCPServer(serverName), {
    onMutate: (variables) => options?.onMutate?.(variables),
    onError: (error, variables, context) => options?.onError?.(error, variables, context),
    onSuccess: (_data, serverName, context) => {
      // Update list cache by removing the deleted server (immutable update)
      const listRes = queryClient.getQueryData<t.MCPServersListResponse>([QueryKeys.mcpServers]);
      if (listRes) {
        const { [serverName]: _removed, ...remaining } = listRes;
        queryClient.setQueryData<t.MCPServersListResponse>([QueryKeys.mcpServers], remaining);
      }

      // Remove from specific server query cache
      queryClient.removeQueries([QueryKeys.mcpServer, serverName]);

      // Invalidate list query to ensure consistency
      queryClient.invalidateQueries([QueryKeys.mcpServers]);
      queryClient.invalidateQueries([QueryKeys.mcpTools]);
      queryClient.invalidateQueries([QueryKeys.mcpAuthValues]);
      queryClient.invalidateQueries([QueryKeys.mcpConnectionStatus]);

      return options?.onSuccess?.(_data, serverName, context);
    },
  });
};

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys, MutationKeys } from 'librechat-data-provider';
import type {
  TLangfuseConnectionStatus,
  TUpdateLangfuseConnectionRequest,
  TLangfuseConnectionTestRequest,
  TLangfuseConnectionTestResponse,
  TLangfuseSessionLinkResponse,
} from 'librechat-data-provider';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';

export const useGetLangfuseConnectionQuery = (
  enabled = true,
): UseQueryResult<TLangfuseConnectionStatus> =>
  useQuery<TLangfuseConnectionStatus>(
    [QueryKeys.langfuseConnection],
    () => dataService.getLangfuseConnection(),
    { enabled, refetchOnWindowFocus: false },
  );

export const useGetLangfuseSessionLinkQuery = (
  conversationId: string,
  enabled = true,
): UseQueryResult<TLangfuseSessionLinkResponse> =>
  useQuery<TLangfuseSessionLinkResponse>(
    [QueryKeys.langfuseSessionLink, conversationId],
    () => dataService.getLangfuseSessionLink(conversationId),
    { enabled, refetchOnWindowFocus: false },
  );

export const useUpdateLangfuseConnectionMutation = (): UseMutationResult<
  TLangfuseConnectionStatus,
  unknown,
  TUpdateLangfuseConnectionRequest
> => {
  const queryClient = useQueryClient();
  return useMutation(
    (payload: TUpdateLangfuseConnectionRequest) => dataService.updateLangfuseConnection(payload),
    {
      mutationKey: [MutationKeys.updateLangfuseConnection],
      onSuccess: (data) => {
        queryClient.setQueryData([QueryKeys.langfuseConnection], data);
        queryClient.removeQueries([QueryKeys.langfuseSessionLink]);
      },
    },
  );
};

export const useTestLangfuseConnectionMutation = (): UseMutationResult<
  TLangfuseConnectionTestResponse,
  unknown,
  TLangfuseConnectionTestRequest
> =>
  useMutation(
    (payload: TLangfuseConnectionTestRequest) => dataService.testLangfuseConnection(payload),
    { mutationKey: [MutationKeys.testLangfuseConnection] },
  );

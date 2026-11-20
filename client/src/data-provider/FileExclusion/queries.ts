import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Constants, MutationKeys, QueryKeys, dataService } from 'librechat-data-provider';
import type { TFileExclusion, TFileExclusionRequest } from 'librechat-data-provider';
import type { UseQueryOptions } from '@tanstack/react-query';

/** The files a conversation leaves out of later turns. Asked for only where they are shown. */
export const useFileExclusionQuery = (
  conversationId: string,
  config?: UseQueryOptions<TFileExclusion>,
) =>
  useQuery<TFileExclusion>(
    [QueryKeys.fileExclusion, conversationId],
    () => dataService.getFileExclusion(conversationId),
    {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      ...config,
      enabled:
        config?.enabled !== false &&
        conversationId !== '' &&
        conversationId !== Constants.NEW_CONVO &&
        conversationId !== Constants.PENDING_CONVO,
    },
  );

export type FileExclusionVariables = TFileExclusionRequest & { conversationId: string };

/**
 * Leaves files out of a conversation or takes them back in. The list is changed at once and put
 * back if the server refuses, so a switch answers the hand that moved it; the server's own list
 * replaces the guess when it answers.
 */
export const useFileExclusionMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<
    TFileExclusion,
    unknown,
    FileExclusionVariables,
    { previous: TFileExclusion | undefined }
  >({
    mutationKey: [MutationKeys.setFileExclusion],
    mutationFn: ({ conversationId, fileIds, excluded }) =>
      dataService.setFileExclusion(conversationId, { fileIds, excluded }),
    onMutate: async ({ conversationId, fileIds, excluded }) => {
      const key = [QueryKeys.fileExclusion, conversationId];
      await queryClient.cancelQueries(key);
      const previous = queryClient.getQueryData<TFileExclusion>(key);
      const kept = (previous?.excludedFiles ?? []).filter((id) => !fileIds.includes(id));
      queryClient.setQueryData<TFileExclusion>(key, {
        excludedFiles: excluded ? [...kept, ...fileIds] : kept,
      });
      return { previous };
    },
    onError: (_error, { conversationId }, context) => {
      queryClient.setQueryData([QueryKeys.fileExclusion, conversationId], context?.previous);
    },
    onSuccess: (data, { conversationId }) => {
      queryClient.setQueryData([QueryKeys.fileExclusion, conversationId], data);
    },
  });
};

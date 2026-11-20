import { Constants, MutationKeys, QueryKeys, dataService } from 'librechat-data-provider';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFileExclusion, TFileExclusionRequest } from 'librechat-data-provider';
import type { QueryClient, UseQueryOptions } from '@tanstack/react-query';

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

/** Conversations with more than one change in flight at some point, per query client. */
const contended = new WeakMap<QueryClient, Set<string>>();

const inFlight = (queryClient: QueryClient, conversationId: string): number =>
  queryClient.isMutating({
    mutationKey: [MutationKeys.setFileExclusion],
    predicate: (mutation) =>
      (mutation.state.variables as FileExclusionVariables | undefined)?.conversationId ===
      conversationId,
  });

/**
 * Whether a change to what the conversation leaves out is still being saved. A turn reads the
 * saved list, so one sent before then would not have the change; whatever sends a message waits
 * on this the way it waits on an upload.
 */
export const useFileExclusionPending = (conversationId: string): boolean =>
  useIsMutating({
    mutationKey: [MutationKeys.setFileExclusion],
    predicate: (mutation) =>
      (mutation.state.variables as FileExclusionVariables | undefined)?.conversationId ===
      conversationId,
  }) > 0;

/**
 * Leaves files out of a conversation or takes them back in. The list is changed at once, so a
 * switch answers the hand that moved it, and only this change is undone if the server refuses.
 *
 * A response carries the whole list as the server had it when that one change landed. With one
 * change in flight that is the truth and replaces the guess. With several, responses can arrive
 * out of order and an earlier list would undo a later change on screen, so none of them is
 * written; the list is read again once the last one settles.
 */
export const useFileExclusionMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<TFileExclusion, unknown, FileExclusionVariables, { changed: string[] }>({
    mutationKey: [MutationKeys.setFileExclusion],
    mutationFn: ({ conversationId, fileIds, excluded }) =>
      dataService.setFileExclusion(conversationId, { fileIds, excluded }),
    onMutate: async ({ conversationId, fileIds, excluded }) => {
      const key = [QueryKeys.fileExclusion, conversationId];
      if (inFlight(queryClient, conversationId) > 1) {
        const ids = contended.get(queryClient) ?? new Set<string>();
        contended.set(queryClient, ids.add(conversationId));
      }
      await queryClient.cancelQueries(key);
      const listed = queryClient.getQueryData<TFileExclusion>(key)?.excludedFiles ?? [];
      /** Only what this change moves, so undoing it leaves every other change in place. */
      const changed = fileIds.filter((id) => listed.includes(id) !== excluded);
      queryClient.setQueryData<TFileExclusion>(key, {
        excludedFiles: excluded
          ? [...listed, ...changed]
          : listed.filter((id) => !changed.includes(id)),
      });
      return { changed };
    },
    onError: (_error, { conversationId, excluded }, context) => {
      const changed = context?.changed ?? [];
      queryClient.setQueryData<TFileExclusion>(
        [QueryKeys.fileExclusion, conversationId],
        (current) => {
          const listed = current?.excludedFiles ?? [];
          return {
            excludedFiles: excluded
              ? listed.filter((id) => !changed.includes(id))
              : [...listed, ...changed.filter((id) => !listed.includes(id))],
          };
        },
      );
    },
    onSuccess: (data, { conversationId }) => {
      const alone =
        inFlight(queryClient, conversationId) === 1 &&
        contended.get(queryClient)?.has(conversationId) !== true;
      if (alone) {
        queryClient.setQueryData([QueryKeys.fileExclusion, conversationId], data);
      }
    },
    onSettled: (_data, _error, { conversationId }) => {
      if (inFlight(queryClient, conversationId) !== 1) {
        return;
      }
      if (contended.get(queryClient)?.delete(conversationId) === true) {
        void queryClient.invalidateQueries([QueryKeys.fileExclusion, conversationId]);
      }
    },
  });
};

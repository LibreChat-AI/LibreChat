import { useMemo, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys, dataService } from 'librechat-data-provider';
import {
  getOptimisticMessages,
  isInitialNewConversation,
  hydrateSubmissionMessages,
  buildOptimisticConversation,
} from '@librechat/chat';
import type { TMessage, TSubmission, TConversation } from 'librechat-data-provider';
import type { ResumableCache } from '@librechat/chat';
import type { ActiveJobsResponse } from '~/data-provider';
import {
  adoptComposerConversation,
  bindComposerLaunch,
  upsertConvoInAllQueries,
  removeConvoFromAllQueries,
  invalidateConversationLists,
} from '~/utils';
import {
  queueTitleGeneration,
  streamStatusQueryKey,
  fetchConversationMessages,
} from '~/data-provider';
import { transferFileSearchPreference } from '~/hooks/Files/search';
import { fetchConvoSnapshot } from '~/utils/convos';

/** The app's query cache, as a resumable run reads and refreshes it. */
export default function useResumableCache(
  getMessages: () => TMessage[] | undefined,
  runIndex = 0,
): ResumableCache {
  const queryClient = useQueryClient();

  /**
   * Optimistically add a job ID to the active jobs cache.
   * Called when generation starts.
   */
  const addActiveJob = useCallback(
    (jobId: string) => {
      queryClient.setQueryData<ActiveJobsResponse>([QueryKeys.activeJobs], (old) => ({
        activeJobIds: [...new Set([...(old?.activeJobIds ?? []), jobId])],
      }));
    },
    [queryClient],
  );

  /**
   * Optimistically remove a job ID from the active jobs cache.
   * Called when generation completes, aborts, or errors.
   */
  const removeActiveJob = useCallback(
    (jobId: string) => {
      queryClient.setQueryData<ActiveJobsResponse>([QueryKeys.activeJobs], (old) => ({
        activeJobIds: (old?.activeJobIds ?? []).filter((id) => id !== jobId),
      }));
    },
    [queryClient],
  );

  const addOptimisticConversation = useCallback(
    (conversationId: string, currentSubmission: TSubmission): TSubmission => {
      if (!isInitialNewConversation(currentSubmission)) {
        return currentSubmission;
      }

      const optimisticConversation = buildOptimisticConversation(currentSubmission, conversationId);
      const optimisticMessages = getOptimisticMessages(
        currentSubmission,
        conversationId,
        getMessages(),
      );

      queryClient.setQueryData<TConversation>(
        [QueryKeys.conversation, conversationId],
        (current) => current ?? optimisticConversation,
      );
      queryClient.setQueryData<TMessage[]>(
        [QueryKeys.messages, conversationId],
        optimisticMessages,
      );
      queryClient.setQueryData<TMessage[]>(
        [QueryKeys.messages, Constants.NEW_CONVO],
        optimisticMessages,
      );
      upsertConvoInAllQueries(queryClient, optimisticConversation);

      const hydrated = hydrateSubmissionMessages(currentSubmission, conversationId);
      if (
        adoptComposerConversation(
          currentSubmission.conversation,
          conversationId,
          runIndex,
          transferFileSearchPreference,
        )
      ) {
        bindComposerLaunch(hydrated.conversation, runIndex);
      }
      return hydrated;
    },
    [getMessages, queryClient, runIndex],
  );

  return useMemo<ResumableCache>(
    () => ({
      invalidateMessages: (conversationId, refetch) =>
        queryClient.invalidateQueries({
          queryKey: [QueryKeys.messages, conversationId],
          refetchType: refetch,
        }),
      fetchMessages: (conversationId, fallback) =>
        queryClient.fetchQuery<TMessage[]>({
          queryKey: [QueryKeys.messages, conversationId],
          ...(fallback === true && {
            // The first stream can finish before CREATED mounts the saved-chat query.
            queryFn: () => fetchConversationMessages(conversationId),
          }),
        }),
      refreshConversation: (conversationId) =>
        queryClient.invalidateQueries({
          queryKey: [QueryKeys.conversation, conversationId],
          refetchType: 'all',
        }),
      refreshConversationLists: () => invalidateConversationLists(queryClient),
      refreshPinnedConversations: () =>
        queryClient.invalidateQueries({ queryKey: [QueryKeys.pinnedConversations] }),
      setStreamStatus: (conversationId, status) =>
        queryClient.setQueryData(streamStatusQueryKey(conversationId), status),
      removeStreamStatus: (conversationId) =>
        queryClient.removeQueries({ queryKey: streamStatusQueryKey(conversationId) }),
      invalidateStreamStatus: (conversationId) =>
        queryClient.invalidateQueries({ queryKey: streamStatusQueryKey(conversationId) }),
      addActiveJob,
      removeActiveJob,
      fetchConversation: (conversationId) =>
        fetchConvoSnapshot(queryClient, conversationId, () =>
          dataService.getConversationById(conversationId),
        ),
      setConversation: (conversationId, conversation) =>
        queryClient.setQueryData([QueryKeys.conversation, conversationId], conversation),
      upsertConversation: (conversation) =>
        upsertConvoInAllQueries(queryClient, conversation, true, 'snapshot'),
      removeConversation: (conversationId) =>
        removeConvoFromAllQueries(queryClient, conversationId),
      getConversation: (conversationId) =>
        queryClient.getQueryData<TConversation>([QueryKeys.conversation, conversationId]),
      removeConversationQueries: (conversationId) => {
        queryClient.removeQueries({ queryKey: [QueryKeys.conversation, conversationId] });
        queryClient.removeQueries({ queryKey: [QueryKeys.messages, conversationId] });
      },
      queueTitleGeneration,
      addOptimisticConversation,
    }),
    [addActiveJob, addOptimisticConversation, queryClient, removeActiveJob],
  );
}

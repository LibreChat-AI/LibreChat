import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys, MutationKeys } from 'librechat-data-provider';
import type { ResponseReviewDecision } from 'librechat-data-provider';

export function useResponseReview(responseId: string, userId?: string, tenantId?: string) {
  return useQuery(
    [QueryKeys.responseReview, userId, tenantId, responseId],
    () => dataService.getResponseReview(responseId),
    {
      enabled: Boolean(userId && responseId),
      retry: false,
      cacheTime: 0,
      refetchInterval: (data, query) =>
        query.state.status === 'error' || (data && !['queued', 'in_progress'].includes(data.status))
          ? false
          : 2000,
    },
  );
}

export function useResponseReviewDecision(responseId: string, userId?: string, tenantId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [MutationKeys.responseReviewDecision, userId, tenantId, responseId],
    mutationFn: (decision: ResponseReviewDecision) => {
      if (!userId || !responseId) throw new Error('Response owner is unavailable');
      return dataService.submitResponseReviewDecision(responseId, decision);
    },
    retry: false,
    onSuccess: () =>
      queryClient.invalidateQueries([QueryKeys.responseReview, userId, tenantId, responseId]),
  });
}

export function useResponseCancel(responseId: string, userId?: string, tenantId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [MutationKeys.responseCancel, userId, tenantId, responseId],
    mutationFn: () => {
      if (!userId || !responseId) throw new Error('Response owner is unavailable');
      return dataService.cancelOwnerResponse(responseId);
    },
    retry: false,
    onSettled: () =>
      queryClient.invalidateQueries([QueryKeys.responseReview, userId, tenantId, responseId]),
  });
}

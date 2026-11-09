import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type { TNmbApproveBody, TNmbRejectBody } from 'librechat-data-provider';
import type { UseMutationResult, UseMutationOptions } from '@tanstack/react-query';

type Resolved = { id: string; status: string };

export const useApproveNmbReviewMutation = (
  options?: UseMutationOptions<
    Resolved & { findings: number },
    unknown,
    { id: string; body: TNmbApproveBody }
  >,
): UseMutationResult<
  Resolved & { findings: number },
  unknown,
  { id: string; body: TNmbApproveBody }
> => {
  const queryClient = useQueryClient();
  return useMutation(({ id, body }) => dataService.approveNmbReview(id, body), {
    ...options,
    onSuccess: (data, variables, context) => {
      queryClient.removeQueries([QueryKeys.nmbOriginal, variables.id]);
      queryClient.invalidateQueries([QueryKeys.nmbReviews]);
      queryClient.invalidateQueries([QueryKeys.nmbBlocklist]);
      options?.onSuccess?.(data, variables, context);
    },
  });
};

export const useRejectNmbReviewMutation = (
  options?: UseMutationOptions<Resolved, unknown, { id: string; body: TNmbRejectBody }>,
): UseMutationResult<Resolved, unknown, { id: string; body: TNmbRejectBody }> => {
  const queryClient = useQueryClient();
  return useMutation(({ id, body }) => dataService.rejectNmbReview(id, body), {
    ...options,
    onSuccess: (data, variables, context) => {
      queryClient.removeQueries([QueryKeys.nmbOriginal, variables.id]);
      queryClient.invalidateQueries([QueryKeys.nmbReviews]);
      options?.onSuccess?.(data, variables, context);
    },
  });
};

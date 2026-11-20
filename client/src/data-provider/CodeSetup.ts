import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DynamicQueryKeys, MutationKeys, QueryKeys, dataService } from 'librechat-data-provider';
import type { CodeSetupApprovalRequest, CodeSetupAttempt } from 'librechat-data-provider';
import { reopenTermsOnRefusal } from '~/utils/terms';

export function useCodeSetupAttemptQuery(attemptId: string, userId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  return useQuery<CodeSetupAttempt, unknown>(
    DynamicQueryKeys.codeSetupAttempt(attemptId, userId),
    () => dataService.getCodeSetupAttempt(attemptId),
    {
      enabled,
      cacheTime: 0,
      retry: false,
      refetchInterval: (data, query) =>
        query.state.error == null &&
        data != null &&
        ['pending', 'provisioning', 'approved'].includes(data.status) &&
        (data.status !== 'pending' || Date.parse(data.expiresAt) > Date.now())
          ? 2_000
          : false,
      refetchIntervalInBackground: false,
      onError: (error) => {
        const data = (error as { response?: { data?: unknown } })?.response?.data;
        reopenTermsOnRefusal(queryClient, data);
      },
    },
  );
}

export function useCodeSetupDecisionMutation(
  attemptId: string,
  userId: string,
  decision: 'approve' | 'deny',
) {
  const queryClient = useQueryClient();
  const queryKey = DynamicQueryKeys.codeSetupAttempt(attemptId, userId);
  return useMutation<CodeSetupAttempt, unknown, CodeSetupApprovalRequest | undefined>({
    mutationKey: [
      decision === 'approve' ? MutationKeys.approveCodeSetup : MutationKeys.denyCodeSetup,
      userId,
      attemptId,
    ],
    mutationFn: (payload) => {
      if (decision === 'deny') {
        return dataService.denyCodeSetupAttempt(attemptId);
      }
      if (payload == null) {
        throw new Error('Code setup approval requires a control plane');
      }
      return dataService.approveCodeSetupAttempt(attemptId, payload);
    },
    retry: false,
    onMutate: () => queryClient.cancelQueries(queryKey),
    onSuccess: async (data) => {
      await queryClient.cancelQueries(queryKey);
      queryClient.setQueryData(queryKey, data);
      void queryClient.invalidateQueries([QueryKeys.codeEnvironments]);
      void queryClient.invalidateQueries([QueryKeys.endpoints]);
    },
    onError: (error) => {
      const data = (error as { response?: { data?: unknown } })?.response?.data;
      reopenTermsOnRefusal(queryClient, data);
    },
    // A lost mutation response is not a rejected decision. Reconcile before offering an action.
    onSettled: () => queryClient.invalidateQueries(queryKey),
  });
}

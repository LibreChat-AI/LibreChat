import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, MutationKeys, dataService } from 'librechat-data-provider';
import type { ScheduleMCPConsentView, ConfirmScheduleMCPConsent } from 'librechat-data-provider';

export function useScheduleMCPConsent(id: string) {
  return useQuery<ScheduleMCPConsentView>(
    [QueryKeys.scheduleMCPConsent, id],
    () => dataService.getScheduleMCPConsent(id),
    {
      retry: false,
      refetchOnWindowFocus: true,
      refetchInterval: 30_000,
    },
  );
}

export function useScheduleMCPConsentMutations(id: string) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries([QueryKeys.scheduleMCPConsent, id]);
    void queryClient.invalidateQueries([QueryKeys.schedules]);
  };
  const confirm = useMutation(
    [MutationKeys.confirmScheduleMCPConsent, id],
    (payload: ConfirmScheduleMCPConsent) => dataService.confirmScheduleMCPConsent(id, payload),
    { onSettled: refresh },
  );
  const revoke = useMutation(
    [MutationKeys.revokeScheduleMCPConsent, id],
    (revision: string) => dataService.revokeScheduleMCPConsent(id, revision),
    { onSettled: refresh },
  );
  return { confirm, revoke };
}

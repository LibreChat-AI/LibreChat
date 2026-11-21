import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, MutationKeys, dataService } from 'librechat-data-provider';
import type { RunGrantView, ConfirmRunGrant } from 'librechat-data-provider';

export function useScheduleMCPConsent(id: string) {
  return useQuery<RunGrantView>(
    [QueryKeys.scheduleMCPConsent, id],
    () => dataService.getScheduleMCPConsent(id),
    {
      retry: false,
      refetchOnWindowFocus: true,
      refetchInterval: 30_000,
    },
  );
}

/**
 * What a schedule of this agent could be allowed. Before the schedule exists, or when an edit
 * moves it to another agent, that is the offer for the agent alone. For a stored schedule
 * that keeps its agent (`scheduleId`) it is the schedule's own offer, which starts from the
 * grant it has.
 */
export function useScheduleMCPOffer(agentId: string, scheduleId?: string) {
  return useQuery<RunGrantView>(
    scheduleId ? [QueryKeys.scheduleMCPConsent, scheduleId] : [QueryKeys.scheduleMCPOffer, agentId],
    () =>
      scheduleId
        ? dataService.getScheduleMCPConsent(scheduleId)
        : dataService.getScheduleMCPOffer(agentId),
    { enabled: agentId !== '', retry: false, refetchOnWindowFocus: false },
  );
}

/**
 * Reads the offer again. A choice is made from one offer and the server checks it against
 * its own: once it turns a choice down, the offer in hand can only be turned down again.
 */
export function useScheduleMCPOfferRefresh(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries([QueryKeys.scheduleMCPOffer]);
    void queryClient.invalidateQueries([QueryKeys.scheduleMCPConsent]);
  }, [queryClient]);
}

export function useScheduleMCPConsentMutations(id: string) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries([QueryKeys.scheduleMCPConsent, id]);
    void queryClient.invalidateQueries([QueryKeys.schedules]);
  };
  const confirm = useMutation(
    [MutationKeys.confirmScheduleMCPConsent, id],
    (payload: ConfirmRunGrant) => dataService.confirmScheduleMCPConsent(id, payload),
    { onSettled: refresh },
  );
  const revoke = useMutation(
    [MutationKeys.revokeScheduleMCPConsent, id],
    (revision: string) => dataService.revokeScheduleMCPConsent(id, revision),
    { onSettled: refresh },
  );
  return { confirm, revoke };
}

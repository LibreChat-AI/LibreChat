import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, MutationKeys, dataService } from 'librechat-data-provider';
import type {
  SubscriptionCreateInput,
  SubscriptionUpdateInput,
  ConnectionChoice,
  ConfirmRunGrant,
  Subscription,
  RunGrantView,
  Watch,
} from 'librechat-data-provider';

/** The caller's event subscriptions on one agent. Idle until the agent is saved. */
export function useEventSubscriptions(agentId?: string) {
  return useQuery<Subscription[]>(
    [QueryKeys.agentEventSubscriptions, agentId],
    () => dataService.getAgentEventSubscriptions(agentId).then((res) => res.subscriptions),
    { enabled: Boolean(agentId), retry: false, refetchOnWindowFocus: false },
  );
}

/** The connections of the caller's tenant a subscription can listen to. */
export function useEventConnections(enabled = true) {
  return useQuery<ConnectionChoice[]>(
    [QueryKeys.agentEventConnections],
    () => dataService.getAgentEventConnections().then((res) => res.connections),
    { enabled, retry: false, refetchOnWindowFocus: false },
  );
}

export function useEventSubscriptionMutations(agentId?: string) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries([QueryKeys.agentEventSubscriptions, agentId]);
    // An edit can leave a grant behind, so every grant this agent's subscriptions hold is read again.
    void queryClient.invalidateQueries([QueryKeys.agentEventSubscriptionGrant]);
  };
  const create = useMutation(
    [MutationKeys.createAgentEventSubscription],
    (payload: SubscriptionCreateInput) => dataService.createAgentEventSubscription(payload),
    { onSettled: refresh },
  );
  const update = useMutation(
    [MutationKeys.updateAgentEventSubscription],
    ({ id, payload }: { id: string; payload: SubscriptionUpdateInput }) =>
      dataService.updateAgentEventSubscription(id, payload),
    { onSettled: refresh },
  );
  const remove = useMutation(
    [MutationKeys.deleteAgentEventSubscription],
    (id: string) => dataService.deleteAgentEventSubscription(id),
    { onSettled: refresh },
  );
  return { create, update, remove };
}

/** The grant one subscription holds: what its runs may use. */
export function useEventGrant(id: string) {
  return useQuery<RunGrantView>(
    [QueryKeys.agentEventSubscriptionGrant, id],
    () => dataService.getAgentEventSubscriptionGrant(id),
    { retry: false, refetchOnWindowFocus: true },
  );
}

export function useEventGrantMutations(id: string) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries([QueryKeys.agentEventSubscriptionGrant, id]);
  };
  const confirm = useMutation(
    [MutationKeys.confirmAgentEventSubscriptionGrant, id],
    (payload: ConfirmRunGrant) => dataService.confirmAgentEventSubscriptionGrant(id, payload),
    { onSettled: refresh },
  );
  const revoke = useMutation(
    [MutationKeys.revokeAgentEventSubscriptionGrant, id],
    (revision: string) => dataService.revokeAgentEventSubscriptionGrant(id, revision),
    { onSettled: refresh },
  );
  return { confirm, revoke };
}

/** The pull requests a conversation follows. Read again on focus, since a run may add one. */
export function useEventWatches(conversationId?: string, enabled = true) {
  return useQuery<Watch[]>(
    [QueryKeys.agentEventWatches, conversationId],
    () => dataService.getAgentEventWatches(conversationId ?? '').then((res) => res.watches),
    { enabled: enabled && Boolean(conversationId), retry: false, refetchOnWindowFocus: true },
  );
}

export function useStopWatch(conversationId?: string) {
  const queryClient = useQueryClient();
  return useMutation(
    [MutationKeys.deleteAgentEventWatch],
    (id: string) => dataService.deleteAgentEventWatch(id),
    {
      onSettled: () => {
        void queryClient.invalidateQueries([QueryKeys.agentEventWatches, conversationId]);
      },
    },
  );
}

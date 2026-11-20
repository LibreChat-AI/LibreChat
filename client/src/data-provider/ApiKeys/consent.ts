import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, MutationKeys, dataService } from 'librechat-data-provider';
import type { ScheduleMCPConsentView, ConfirmScheduleMCPConsent } from 'librechat-data-provider';

/** The agents a key can be granted for: the ones its owner may run remotely. */
export function useApiKeyAgents() {
  return useQuery([QueryKeys.apiKeyAgents], () => dataService.getApiKeyAgents(), {
    select: (response) => response.agents,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** The MCP grant an API key holds for one agent. Idle until an agent is chosen. */
export function useApiKeyMCPConsent(keyId: string, agentId: string) {
  return useQuery<ScheduleMCPConsentView>(
    [QueryKeys.apiKeyMCPConsent, keyId, agentId],
    () => dataService.getApiKeyMCPConsent(keyId, agentId),
    {
      enabled: agentId !== '',
      retry: false,
      refetchOnWindowFocus: true,
    },
  );
}

export function useApiKeyMCPConsentMutations(keyId: string, agentId: string) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries([QueryKeys.apiKeyMCPConsent, keyId, agentId]);
  };
  const confirm = useMutation(
    [MutationKeys.confirmApiKeyMCPConsent, keyId, agentId],
    (payload: ConfirmScheduleMCPConsent) =>
      dataService.confirmApiKeyMCPConsent(keyId, agentId, payload),
    { onSettled: refresh },
  );
  const revoke = useMutation(
    [MutationKeys.revokeApiKeyMCPConsent, keyId, agentId],
    (revision: string) => dataService.revokeApiKeyMCPConsent(keyId, agentId, revision),
    { onSettled: refresh },
  );
  return { confirm, revoke };
}

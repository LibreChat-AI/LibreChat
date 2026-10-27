import {
  QueryKeys,
  ReasoningEffort,
  getEndpointField,
  resolveModelReasoning,
  isAgentsEndpoint,
  isReasoningOverrideSupported,
  resolveReasoningSettingForTarget,
} from 'librechat-data-provider';
import type {
  Agent,
  TMessage,
  TConversation,
  TEndpointsConfig,
  TReasoningCapabilitiesResponse,
} from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import { usesReasoningCapabilities } from '~/hooks/Endpoint/useModelReasoning';
import { resolveAgentTarget } from '~/utils';

type ReasoningOverride = NonNullable<TMessage['reasoningOverride']>;

type ResolveReasoningArgs = {
  queryClient: QueryClient;
  agentsMap?: Record<string, Agent | undefined> | null;
  endpoint?: string | null;
  conversation?: TConversation | null;
  endpointsConfig?: TEndpointsConfig;
  reasoningOverride: ReasoningOverride;
  /** The override came out of the pending atom rather than from the caller. */
  drainedReasoning: boolean;
  stagedReasoning?: TMessage['reasoningOverride'];
};

/**
 * Checks a request-scoped reasoning override against the endpoint's loaded capabilities. An
 * unsupported override is dropped; `restoreStaged` asks the caller to put a drained one back
 * when it was refused only because the catalog is not loaded yet.
 */
export function resolveSubmittedReasoning({
  queryClient,
  agentsMap,
  endpoint,
  conversation,
  endpointsConfig,
  reasoningOverride,
  drainedReasoning,
  stagedReasoning,
}: ResolveReasoningArgs): {
  reasoningOverride: TMessage['reasoningOverride'];
  restoreStaged: boolean;
} {
  const isAgent = isAgentsEndpoint(endpoint);
  const agentId = isAgent ? conversation?.agent_id : undefined;
  const savedAgent =
    agentId != null
      ? (queryClient.getQueryData<Agent>([QueryKeys.agent, agentId]) ?? agentsMap?.[agentId])
      : undefined;
  const agentTarget = isAgent ? resolveAgentTarget(agentId, savedAgent) : undefined;
  const effectiveEndpoint = isAgent ? agentTarget?.provider : endpoint;
  const effectiveModel = isAgent ? agentTarget?.model : conversation?.model;
  const effectiveEndpointType = getEndpointField(endpointsConfig, effectiveEndpoint, 'type');
  const customParams =
    effectiveEndpoint == null ? undefined : endpointsConfig?.[effectiveEndpoint]?.customParams;
  const capabilitiesKey = [QueryKeys.reasoningCapabilities, effectiveEndpoint];
  /* A failed or running refresh leaves the previous data cached, and so does an entry that is
     past its lifetime while its refetch has not started (a throttled background tab): the
     efforts are unknown in all three, as they are in the editors. */
  const capabilitiesState = queryClient.getQueryState(capabilitiesKey);
  const cachedCapabilities =
    queryClient.getQueryData<TReasoningCapabilitiesResponse>(capabilitiesKey);
  const capabilitiesExpired =
    cachedCapabilities != null &&
    Date.now() - (capabilitiesState?.dataUpdatedAt ?? 0) >= cachedCapabilities.expiresInMs;
  const capabilitiesData =
    capabilitiesState?.status === 'error' ||
    capabilitiesState?.fetchStatus === 'fetching' ||
    capabilitiesExpired
      ? undefined
      : cachedCapabilities?.capabilities;
  /* Auto sends no effort, so no catalog can refuse it and a restored one is always kept. */
  const clearsEffort =
    reasoningOverride.key === 'reasoning_effort' &&
    reasoningOverride.value === ReasoningEffort.unset &&
    usesReasoningCapabilities(endpointsConfig, effectiveEndpoint ?? '');
  /* A replayed override is checked against the loaded per-model efforts. While they are
     unknown (never requested, running or failed) `resolveModelReasoning` offers nothing, so
     the override is omitted rather than sent and refused by the server. */
  const supportedSetting =
    effectiveEndpoint == null
      ? undefined
      : resolveReasoningSettingForTarget({
          endpoint: effectiveEndpointType ?? effectiveEndpoint,
          model: effectiveModel,
          isAgent,
          defaultParamsEndpoint: customParams?.defaultParamsEndpoint,
          reasoningFormat: customParams?.reasoningFormat,
          paramDefinitions: customParams?.paramDefinitions,
          modelReasoning:
            effectiveModel == null || clearsEffort
              ? undefined
              : resolveModelReasoning({
                  capabilities: capabilitiesData,
                  endpoint: effectiveEndpoint,
                  model: effectiveModel,
                  paramDefinitions: customParams?.paramDefinitions,
                }),
        });

  if (isReasoningOverrideSupported(reasoningOverride, supportedSetting)) {
    return { reasoningOverride, restoreStaged: false };
  }
  /* Refused only because the catalog is not known yet, not because it said no: the user's
     one-shot choice is put back instead of being lost, and applies once it can be checked. */
  const restoreStaged =
    drainedReasoning &&
    stagedReasoning != null &&
    capabilitiesData == null &&
    usesReasoningCapabilities(endpointsConfig, effectiveEndpoint ?? '');
  return { reasoningOverride: undefined, restoreStaged };
}

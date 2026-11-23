import { useMemo } from 'react';
import { PermissionBits, isAgentsEndpoint, isEphemeralAgentId } from 'librechat-data-provider';
import type { AgentListResponse, TStartupConfig } from 'librechat-data-provider';
import { useListAgentsQuery } from '~/data-provider/Agents/queries';
import { useCatalogReady } from '~/hooks/useCatalogWarmup';

const viewAgents = { requiredPermission: PermissionBits.VIEW };
const selectIds = (response: AgentListResponse) => new Set(response.data.map((agent) => agent.id));

/** Only a complete VIEW catalog can prove an agent-backed spec is unavailable. */
export default function useModelSpecs(startupConfig?: TStartupConfig) {
  const ready = useCatalogReady('agents');
  const specs = startupConfig?.modelSpecs?.list;
  const needsAgents =
    specs?.some(
      (spec) =>
        isAgentsEndpoint(spec.preset.endpoint) &&
        !!spec.preset.agent_id &&
        !isEphemeralAgentId(spec.preset.agent_id),
    ) ?? false;
  const agents = useListAgentsQuery(viewAgents, {
    select: selectIds,
    enabled: ready && needsAgents,
  });
  return useMemo(() => {
    if (!specs) return [];
    const visibleIds = agents.data;
    if (!agents.isComplete || agents.isFetching || !visibleIds) return specs;
    return specs.filter(
      (spec) =>
        !isAgentsEndpoint(spec.preset.endpoint) ||
        !spec.preset.agent_id ||
        isEphemeralAgentId(spec.preset.agent_id) ||
        visibleIds.has(spec.preset.agent_id),
    );
  }, [specs, agents.data, agents.isComplete, agents.isFetching]);
}

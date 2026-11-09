import { useMemo } from 'react';
import { PermissionBits } from 'librechat-data-provider';
import type { TAgentsMap, AgentListResponse } from 'librechat-data-provider';
import { useCatalogReady } from '~/hooks/useCatalogWarmup';
import { useListAgentsQuery } from '~/data-provider';
import { mapAgents } from '~/utils';

const selectAgents = (res: AgentListResponse) => mapAgents(res.data);

export default function useAgentsMap({
  isAuthenticated,
  enabled,
}: {
  isAuthenticated: boolean;
  enabled?: boolean;
}): TAgentsMap | undefined {
  const ready = useCatalogReady('agents');
  const { data: mappedAgents = null } = useListAgentsQuery(
    { requiredPermission: PermissionBits.VIEW },
    {
      select: selectAgents,
      enabled: isAuthenticated && (enabled ?? ready),
    },
  );

  const agentsMap = useMemo<TAgentsMap | undefined>(() => {
    return mappedAgents !== null ? mappedAgents : undefined;
  }, [mappedAgents]);

  return agentsMap;
}

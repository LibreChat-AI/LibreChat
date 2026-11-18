import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys, PermissionBits, EModelEndpoint } from 'librechat-data-provider';
import type { TAgentsMap, AgentListResponse, TEndpointsConfig } from 'librechat-data-provider';
import { useCatalogReady } from '~/hooks/useCatalogWarmup';
import { useListAgentsQuery } from '~/data-provider';
import { mapAgents } from '~/utils';

const selectAgents = (res: AgentListResponse) => mapAgents(res.data);
type Options = { isAuthenticated: boolean; enabled?: boolean };

/** The Root-owned incremental catalog and whether missing metadata may still arrive. */
export function useAgentsCatalog({ isAuthenticated, enabled }: Options) {
  const ready = useCatalogReady('agents');
  const client = useQueryClient();
  const query = useListAgentsQuery(
    { requiredPermission: PermissionBits.VIEW },
    { select: selectAgents, enabled: isAuthenticated && (enabled ?? ready) },
  );
  const mapped = query.data;
  const agentsMap = useMemo<TAgentsMap | undefined>(() => mapped ?? undefined, [mapped]);
  const endpoints = client.getQueryState<TEndpointsConfig>([QueryKeys.endpoints]);
  const unavailable =
    endpoints?.data != null
      ? !endpoints.data[EModelEndpoint.agents]
      : endpoints?.status === 'error';
  const pending =
    isAuthenticated &&
    enabled !== false &&
    !unavailable &&
    (query.fetchStatus !== 'idle' || (!query.isComplete && !query.isError));
  return { agentsMap, pending };
}

export default function useAgentsMap(options: Options): TAgentsMap | undefined {
  return useAgentsCatalog(options).agentsMap;
}

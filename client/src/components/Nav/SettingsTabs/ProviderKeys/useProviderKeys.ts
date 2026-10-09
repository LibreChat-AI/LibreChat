import { useMemo } from 'react';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import { getUserKeyEndpoints } from './utils';
import { useHasAccess } from '~/hooks';

/**
 * Reachable endpoints requiring a user-provided key, filtered the same way the model
 * selector and mention popover are (modelSpecs, addedEndpoints, agent allowedProviders).
 */
export default function useProviderKeys(): string[] {
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const { data: startupConfig } = useGetStartupConfig();
  const hasAgentAccess = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.USE,
  });

  return useMemo(
    () =>
      getUserKeyEndpoints({
        endpointsConfig,
        modelSpecs: startupConfig?.modelSpecs,
        hasAgentAccess: hasAgentAccess === true,
      }),
    [endpointsConfig, startupConfig?.modelSpecs, hasAgentAccess],
  );
}

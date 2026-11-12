import { useCallback } from 'react';
import { resolveSender } from '@librechat/chat';
import type { TEndpointOption } from 'librechat-data-provider';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';

/**
 * The response sender label for an endpoint option, from the loaded endpoints and model specs;
 * see `resolveSender` for the resolution order and the agent exemption.
 */
export default function useGetSender() {
  const { data: startupConfig } = useGetStartupConfig();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  return useCallback(
    (endpointOption: TEndpointOption) =>
      resolveSender(endpointOption, endpointsConfig, startupConfig?.modelSpecs?.list),
    [endpointsConfig, startupConfig],
  );
}

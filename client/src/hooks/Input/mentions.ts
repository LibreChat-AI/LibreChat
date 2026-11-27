import { EModelEndpoint, isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';

export function filterMentionEndpoints({
  endpoints,
  includedEndpoints,
  includeAssistants,
  hasAgentAccess,
}: {
  endpoints: Array<EModelEndpoint | string>;
  includedEndpoints: Set<string>;
  includeAssistants: boolean;
  hasAgentAccess: boolean;
}) {
  const hasEndpointAllowList = includedEndpoints.size > 0;

  return endpoints.filter((endpoint) => {
    if (!includeAssistants && isAssistantsEndpoint(endpoint)) {
      return false;
    }

    if (isAgentsEndpoint(endpoint) && !hasAgentAccess) {
      return false;
    }

    if (hasEndpointAllowList && !includedEndpoints.has(endpoint)) {
      return false;
    }

    return true;
  });
}

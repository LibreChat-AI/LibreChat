import {
  QueryKeys,
  isAgentsEndpoint,
  isEphemeralAgentId,
  parseEphemeralAgentId,
  isAssistantsEndpoint,
  resolveModelCatalogKey,
} from 'librechat-data-provider';
import type {
  TModelsConfig,
  TEndpointsConfig,
  TModelSpec,
  TConversation,
} from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';

/** Ignore the static seed, but retain a fetched catalog when a later request fails. */
export function getModelCatalog(queryClient: QueryClient): TModelsConfig | undefined {
  const state = queryClient.getQueryState<TModelsConfig>([QueryKeys.models]);
  return state?.dataUpdateCount
    ? queryClient.getQueryData<TModelsConfig>([QueryKeys.models])
    : undefined;
}

/** Keep agent groups reachable. Apply discovery only after a response arrives. */
export function isProviderAvailable(endpoint: string, models: TModelsConfig | undefined): boolean {
  return (
    models == null ||
    isAgentsEndpoint(endpoint) ||
    isAssistantsEndpoint(endpoint) ||
    (models[resolveModelCatalogKey(endpoint, models)]?.length ?? 0) > 0
  );
}

export function isModelSpecAvailable(spec: TModelSpec, models: TModelsConfig | undefined): boolean {
  const endpoint = spec.preset.endpoint;
  if (models == null || !endpoint || isAgentsEndpoint(endpoint) || isAssistantsEndpoint(endpoint)) {
    return true;
  }
  const available = models[resolveModelCatalogKey(endpoint, models)] ?? [];
  return spec.preset.model ? available.includes(spec.preset.model) : available.length > 0;
}

/** Match the existing model checks. The server still owns authorization. */
export function isConversationModelAvailable({
  conversation,
  models,
  endpoints,
}: {
  conversation: TConversation | null | undefined;
  models: TModelsConfig | undefined;
  endpoints: TEndpointsConfig | null | undefined;
}): boolean {
  let endpoint: string | null | undefined = conversation?.endpoint;
  let model = conversation?.model?.trim();
  if (!endpoint || !endpoints?.[endpoint]) {
    return false;
  }
  if (isAgentsEndpoint(endpoint)) {
    // Saved agents own their model settings. Their public list omits those settings;
    // the existing server checks validate the agent and its nested agents at send time.
    if (!isEphemeralAgentId(conversation?.agent_id)) {
      return !!endpoints?.[endpoint];
    }
    const target = parseEphemeralAgentId(conversation?.agent_id ?? '');
    endpoint = target?.endpoint;
    model = target?.model;
  }
  if (!endpoint || !endpoints?.[endpoint] || !model) {
    return false;
  }
  // Only Assistants use the legacy send path. Other chats validate the catalog through agents.
  if (
    endpoints[endpoint]?.userProvide &&
    isAssistantsEndpoint(conversation?.endpointType ?? conversation?.endpoint)
  ) {
    return true;
  }
  return models == null || (models[resolveModelCatalogKey(endpoint, models)] ?? []).includes(model);
}

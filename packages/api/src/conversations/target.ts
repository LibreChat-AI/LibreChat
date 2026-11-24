import {
  getEndpointField,
  isAgentsEndpoint,
  isAssistantsEndpoint,
  isEphemeralAgentId,
  resolveModelSpecEndpoint,
  resolveModelCatalogKey,
} from 'librechat-data-provider';
import type { TEndpointsConfig, TModelsConfig, TSpecsConfig } from 'librechat-data-provider';
import { findModelSpecByName } from '../modelSpecs';

export type ConversationTarget = {
  endpoint?: string | null;
  model?: string | null;
  spec?: string | null;
  agent_id?: string | null;
  assistant_id?: string | null;
};

export type ResolvedSpecTarget = {
  endpoint: string;
  endpointType: string | undefined;
  model: string;
  agent_id: undefined;
};

type TargetDependencies = {
  getModelSpecs: () => Promise<Pick<TSpecsConfig, 'enforce' | 'list'> | undefined>;
  getEndpoints: () => Promise<TEndpointsConfig>;
  getModels: (endpoint: string) => Promise<TModelsConfig>;
};

/** Resolve a provider-backed conversation against its named spec after its old route is removed. */
export async function resolveSavedSpecTarget(
  stored: ConversationTarget,
  deps: TargetDependencies,
): Promise<ResolvedSpecTarget | undefined> {
  if (
    !stored.endpoint ||
    !stored.spec ||
    !isEphemeralAgentId(stored.agent_id) ||
    isAgentsEndpoint(stored.endpoint) ||
    isAssistantsEndpoint(stored.endpoint) ||
    stored.assistant_id
  ) {
    return undefined;
  }

  const specs = await deps.getModelSpecs();
  const spec = findModelSpecByName(specs, stored.spec);
  const endpoint = resolveModelSpecEndpoint(spec);
  if (
    !spec ||
    !endpoint ||
    endpoint === stored.endpoint ||
    spec.preset.agent_id ||
    spec.preset.assistant_id ||
    isAgentsEndpoint(endpoint) ||
    isAssistantsEndpoint(endpoint)
  ) {
    return undefined;
  }

  const endpoints = await deps.getEndpoints();
  if (
    !endpoints ||
    Object.prototype.hasOwnProperty.call(endpoints, stored.endpoint) ||
    !Object.prototype.hasOwnProperty.call(endpoints, endpoint) ||
    !endpoints[endpoint]
  ) {
    return undefined;
  }

  let model = spec.preset.model;
  if (!specs?.enforce && stored.model && stored.model !== model) {
    const models = await deps.getModels(endpoint);
    if (models[resolveModelCatalogKey(endpoint, models)]?.includes(stored.model)) {
      model = stored.model;
    }
  }
  if (!model) {
    return undefined;
  }

  return {
    endpoint,
    endpointType: getEndpointField(endpoints, endpoint, 'type'),
    model,
    agent_id: undefined,
  };
}

import {
  getEndpointField,
  isAgentsEndpoint,
  isAssistantsEndpoint,
  isEphemeralAgentId,
  resolveModelSpecEndpoint,
  resolveModelCatalogKey,
} from 'librechat-data-provider';
import type { TEndpointsConfig, TModelsConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { CatalogDiscoveryOptions } from '~/endpoints/models';
import { findModelSpecByName } from '../modelSpecs';
import { loadStrictAppConfig } from '../app/strict';

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
  getModelSpecs: () => Promise<AppConfig['modelSpecs']>;
  getEndpoints: () => Promise<TEndpointsConfig>;
  getModels: (endpoint: string) => Promise<TModelsConfig>;
};

type ConfigRequest = Pick<Parameters<typeof loadStrictAppConfig>[0], 'user' | 'config'>;

type TargetReaders<Request extends ConfigRequest> = {
  getAppConfig: Parameters<typeof loadStrictAppConfig>[1];
  getEndpointsConfig: (req: Request) => Promise<TEndpointsConfig>;
  getEndpointModelsConfig: (
    req: Request,
    endpoint: string,
    options: CatalogDiscoveryOptions,
  ) => Promise<TModelsConfig>;
};

/** Reads the effective configuration only when the saved target can be recovered. */
export function createSavedSpecTargetResolver<Request extends ConfigRequest>(
  readers: TargetReaders<Request>,
) {
  return (req: Request, stored: ConversationTarget): Promise<ResolvedSpecTarget | undefined> =>
    resolveSavedSpecTarget(stored, {
      async getModelSpecs() {
        req.config = await loadStrictAppConfig(req, (options) =>
          readers.getAppConfig({ ...options, skipRuntimeAugmentation: true }),
        );
        return req.config.modelSpecs;
      },
      getEndpoints: () => readers.getEndpointsConfig(req),
      getModels: (endpoint) =>
        readers.getEndpointModelsConfig(req, endpoint, { strictDiscovery: true }),
    });
}

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
  const preset = spec?.preset;
  if (
    !preset ||
    !endpoint ||
    endpoint === stored.endpoint ||
    preset.agent_id ||
    preset.assistant_id ||
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

  let model = preset.model;
  if (!specs?.enforce && stored.model && stored.model !== model) {
    const models = await deps.getModels(endpoint);
    const catalog = models[resolveModelCatalogKey(endpoint, models)];
    if (!Array.isArray(catalog)) {
      throw new Error('Replacement model catalog unavailable');
    }
    if (catalog.includes(stored.model)) {
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

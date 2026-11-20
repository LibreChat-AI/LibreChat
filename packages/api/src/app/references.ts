import { normalizeEndpointName } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';

type ModelSpecs = NonNullable<AppConfig['modelSpecs']>;
type ModelSpecList = ModelSpecs['list'];

/** Folds each name the way the runtime serves it and drops repeats; the same array when unchanged. */
function normalizeEndpointNames(names: string[] | undefined): string[] | undefined {
  if (!names?.length) {
    return names;
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  let changed = false;
  for (const name of names) {
    const served = normalizeEndpointName(name);
    if (seen.has(served)) {
      changed = true;
      continue;
    }
    seen.add(served);
    normalized.push(served);
    changed ||= served !== name;
  }
  return changed ? normalized : names;
}

/** Folds each spec's `preset.endpoint`; the same list, and the same specs, when unchanged. */
function normalizeSpecEndpoints(list: ModelSpecList): ModelSpecList {
  if (!list?.length) {
    return list;
  }
  let changed = false;
  const normalized = list.map((spec) => {
    const endpoint = spec?.preset?.endpoint;
    if (typeof endpoint !== 'string') {
      return spec;
    }
    const served = normalizeEndpointName(endpoint);
    if (served === endpoint) {
      return spec;
    }
    changed = true;
    return { ...spec, preset: { ...spec.preset, endpoint: served } };
  });
  return changed ? normalized : list;
}

function normalizeModelSpecs(modelSpecs: AppConfig['modelSpecs']): AppConfig['modelSpecs'] {
  if (modelSpecs == null) {
    return modelSpecs;
  }
  const list = normalizeSpecEndpoints(modelSpecs.list);
  const addedEndpoints = normalizeEndpointNames(modelSpecs.addedEndpoints);
  if (list === modelSpecs.list && addedEndpoints === modelSpecs.addedEndpoints) {
    return modelSpecs;
  }
  return {
    ...modelSpecs,
    ...(list !== modelSpecs.list && { list }),
    ...(addedEndpoints !== modelSpecs.addedEndpoints && { addedEndpoints }),
  };
}

/**
 * Rewrites the endpoint names the effective config refers to into the names the runtime
 * serves (`normalizeEndpointName`, which folds `Ollama` to `ollama`), without repeats:
 * `modelSpecs.addedEndpoints`, each `modelSpecs.list[].preset.endpoint`, and
 * `endpoints.agents.allowedProviders`. Their consumers (the endpoint menu, agent provider
 * checks, the agent builder) compare them verbatim with served endpoint keys, so a YAML or
 * admin-written `Ollama` would otherwise match nothing.
 *
 * Returns the same config object when nothing changes, so cached configs keep their identity.
 */
export function normalizeEndpointReferences(config: AppConfig): AppConfig {
  const modelSpecs = normalizeModelSpecs(config.modelSpecs);
  const agents = config.endpoints?.agents;
  const allowedProviders = normalizeEndpointNames(agents?.allowedProviders);
  const agentsChanged = allowedProviders !== agents?.allowedProviders;
  if (modelSpecs === config.modelSpecs && !agentsChanged) {
    return config;
  }
  return {
    ...config,
    ...(modelSpecs !== config.modelSpecs && { modelSpecs }),
    ...(agentsChanged && {
      endpoints: { ...config.endpoints, agents: { ...agents, allowedProviders } },
    }),
  };
}

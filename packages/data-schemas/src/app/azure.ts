import {
  EModelEndpoint,
  validateAzureGroups,
  mapModelToAzureConfig,
} from 'librechat-data-provider';
import type {
  TAzureConfig,
  TCustomConfig,
  TValidatedAzureConfig,
  TAzureConfigValidationResult,
} from 'librechat-data-provider';
import logger from '~/config/winston';

/** What Azure `groups` resolve to: the fields the Azure clients read instead of the groups. */
export type ResolvedAzureGroups = TAzureConfigValidationResult & {
  assistantModels: string[];
  assistantGroups: string[];
};

/** A field of the resolved Azure config that its `groups` decide. */
export type AzureResolvedGroupField =
  | 'groupMap'
  | 'modelGroupMap'
  | 'modelNames'
  | 'assistantModels'
  | 'assistantGroups';

/**
 * The fields of the resolved Azure config that its `groups` decide, which the Azure clients,
 * model lists and assistants read. A config override's `groups` resolve to them as
 * librechat.yaml's do ({@link resolveAzureGroups}).
 */
export const AZURE_RESOLVED_GROUP_FIELDS: readonly AzureResolvedGroupField[] = [
  'groupMap',
  'modelGroupMap',
  'modelNames',
  'assistantModels',
  'assistantGroups',
];

/** The fields of a resolved Azure config its `groups` decide ({@link AZURE_RESOLVED_GROUP_FIELDS}). */
export type AzureGroupResolution = Pick<ResolvedAzureGroups, AzureResolvedGroupField>;

/** What Azure `groups` resolve to where none are left: no group, and no model or assistant. */
export function getEmptyAzureResolution(): AzureGroupResolution {
  return {
    groupMap: {},
    modelGroupMap: {},
    modelNames: [],
    assistantModels: [],
    assistantGroups: [],
  };
}

/**
 * An Azure config with each field its groups resolve to that it lacks resolved to none
 * ({@link getEmptyAzureResolution}), and the fields it lacked. An Azure endpoint is served without
 * them where a layer recreates it after a tombstone removed it with everything its groups resolved
 * to (a tombstone of the endpoint or of `endpoints`), or where only a layer defines it, without
 * groups that resolve: no groups are left for it. Their absence would read differently: the model
 * lists fall back to the environment's default Azure models, which the Azure client cannot map to
 * a group. `config` is returned itself when it lacks none.
 */
export function completeAzureResolution<T extends Partial<AzureGroupResolution>>(
  config: T,
): { config: T; completed: AzureResolvedGroupField[] } {
  const completed = AZURE_RESOLVED_GROUP_FIELDS.filter((field) => config[field] == null);
  if (completed.length === 0) {
    return { config, completed };
  }
  const empty = getEmptyAzureResolution();
  const filled = Object.fromEntries(completed.map((field) => [field, empty[field]]));
  return { config: { ...config, ...filled }, completed };
}

/**
 * Whether an Azure config turns `assistants` on without a model that supports them, which
 * `azureConfigSetup` refuses: the Azure Assistants client would have no model to default to.
 */
export function lacksAzureAssistantModels(config: {
  assistants?: unknown;
  assistantModels?: unknown;
}): boolean {
  const { assistants, assistantModels } = config;
  return Boolean(assistants) && !(Array.isArray(assistantModels) && assistantModels.length > 0);
}

/** The maps of a resolved Azure config that say which group serves a model. */
type AzureModelMaps = Partial<Pick<TValidatedAzureConfig, 'groupMap' | 'modelGroupMap'>>;

/**
 * The name of the group that serves `modelName`: the one `modelGroupMap` maps it to, when
 * `groupMap` holds that group and the group lists the model. Values an override wrote in any
 * shape are read defensively.
 */
function getServingGroupName(maps: AzureModelMaps, modelName: unknown): string | undefined {
  if (typeof modelName !== 'string' || maps.modelGroupMap == null) {
    return undefined;
  }
  const groupName = maps.modelGroupMap[modelName]?.group;
  const group = typeof groupName === 'string' ? maps.groupMap?.[groupName] : undefined;
  const models = group?.models;
  return models != null &&
    typeof models === 'object' &&
    Object.prototype.hasOwnProperty.call(models, modelName)
    ? groupName
    : undefined;
}

/**
 * Whether the group `modelGroupMap` maps `modelName` to serves it with assistants, as
 * `azureConfigSetup` has always judged it: the group's `assistants`, or an `assistants` flag on
 * an entry the group holds under the model's name.
 */
function supportsAzureAssistants(maps: AzureModelMaps, modelName: string): boolean {
  const groupName = maps.modelGroupMap?.[modelName]?.group;
  const group = groupName != null ? maps.groupMap?.[groupName] : undefined;
  if (group == null) {
    return false;
  }
  if (group.assistants) {
    return true;
  }
  const named: unknown = Object.getOwnPropertyDescriptor(group, modelName)?.value;
  return (
    named != null && typeof named === 'object' && 'assistants' in named && Boolean(named.assistants)
  );
}

/**
 * Resolves Azure `groups` into the maps the Azure clients read (`groupMap`, `modelGroupMap`), the
 * models they serve and the assistants among them. The groups are validated here, so any value
 * is accepted: a malformed list, or a structural problem (a duplicate group or model, a group
 * without an instance, a serverless one without a base URL), is reported in `errors` with
 * `isValid: false`. The per-model settings each request resolves are not checked.
 */
export function resolveAzureGroups(groups: unknown): ResolvedAzureGroups {
  const validation = validateAzureGroups(groups);
  const { isValid, modelNames, modelGroupMap } = validation;
  const assistantModels: string[] = [];
  const assistantGroups = new Set<string>();
  for (const modelName of isValid ? modelNames : []) {
    const groupName = modelGroupMap[modelName]?.group;
    if (groupName != null && supportsAzureAssistants(validation, modelName)) {
      assistantModels.push(modelName);
      assistantGroups.add(groupName);
    }
  }
  return { ...validation, assistantModels, assistantGroups: Array.from(assistantGroups) };
}

/**
 * {@link resolveAzureGroups}, also refusing groups a request could not be built from, as
 * `azureConfigSetup` refuses them in librechat.yaml at startup: a model whose group lacks the
 * instance, deployment name or version it needs, or a `${VAR}` reference no environment variable
 * answers. Only the models of `checked` groups are tried (every group's without it): groups
 * librechat.yaml alone defines passed at startup. The first such problem is added to `errors`,
 * with `isValid: false`.
 */
export function resolveServedAzureGroups(
  groups: unknown,
  checked?: ReadonlySet<string>,
): ResolvedAzureGroups {
  const resolved = resolveAzureGroups(groups);
  if (!resolved.isValid) {
    return resolved;
  }
  const { modelGroupMap, groupMap } = resolved;
  for (const modelName of resolved.modelNames) {
    const group = modelGroupMap[modelName]?.group;
    if (checked != null && (group == null || !checked.has(group))) {
      continue;
    }
    try {
      mapModelToAzureConfig({ modelName, modelGroupMap, groupMap });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...resolved, isValid: false, errors: [...resolved.errors, message] };
    }
  }
  return resolved;
}

/**
 * A `groups` item as the Azure clients read it once resolved (a `groupMap` entry): its fields
 * with the defaults `validateAzureGroups` gives them, without its `group` name. Unknown fields
 * stay, so a key's companions (`apiKeyPreview`, `apiKeyBinding`) travel with it.
 */
export function toAzureGroupMapEntry(item: Record<string, unknown>): Record<string, unknown> {
  const {
    group: _group,
    instanceName = '',
    deploymentName = '',
    version = '',
    baseURL = '',
    serverless = false,
    ...rest
  } = item;
  return { ...rest, instanceName, deploymentName, version, baseURL, serverless };
}

/** The lists of a resolved Azure config that name models or groups its maps must serve. */
type AzureServedList = Extract<
  AzureResolvedGroupField,
  'modelNames' | 'assistantModels' | 'assistantGroups'
>;

/** A resolved Azure config as the served lists are judged on. */
type AzureServedConfig = AzureModelMaps & Partial<Pick<TValidatedAzureConfig, AzureServedList>>;

/**
 * A resolved Azure config whose lists name only what its maps serve: `modelNames` the models
 * `modelGroupMap` maps to a `groupMap` group that lists them, `assistantModels` those among them
 * that support assistants, and `assistantGroups` the groups serving those. Groups resolve to
 * consistent lists on their own (`resolveAzureGroups`); a list a config override writes
 * directly, or one whose maps a later override replaced or removed, can name a model no group
 * serves, which the Azure clients cannot map (`mapModelToAzureConfig`) and the Azure Assistants
 * client would default to. `narrowed` names the lists that changed; `config` is returned itself
 * when none did.
 */
export function narrowAzureServedModels<T extends AzureServedConfig>(
  config: T,
): { config: T; narrowed: AzureServedList[] } {
  const next: T = { ...config };
  const narrowed: AzureServedList[] = [];
  const narrow = (field: AzureServedList, keep: (value: unknown) => boolean) => {
    const list: unknown = config[field];
    if (list === undefined) {
      return;
    }
    const kept = Array.isArray(list) ? list.filter(keep) : [];
    if (Array.isArray(list) && kept.length === list.length) {
      return;
    }
    next[field] = kept;
    narrowed.push(field);
  };
  const isServed = (model: unknown): model is string => getServingGroupName(config, model) != null;
  narrow('modelNames', isServed);
  narrow('assistantModels', (model) => isServed(model) && supportsAzureAssistants(config, model));
  const assistantGroups = new Set(
    (next.assistantModels ?? []).map((model) => getServingGroupName(config, model)),
  );
  narrow('assistantGroups', (group) => typeof group === 'string' && assistantGroups.has(group));
  return { config: narrowed.length === 0 ? config : next, narrowed };
}

/**
 * Sets up the Azure OpenAI configuration from the config (`librechat.yaml`) file.
 * @param config - The loaded custom configuration.
 * @returns The Azure OpenAI configuration.
 */
export function azureConfigSetup(config: Partial<TCustomConfig>): TAzureConfig {
  const azureConfig = config.endpoints?.[EModelEndpoint.azureOpenAI];
  if (!azureConfig) {
    throw new Error('Azure OpenAI configuration is missing.');
  }
  const { groups, ...azureConfiguration } = azureConfig;
  const resolved = resolveAzureGroups(groups);
  const { isValid, modelNames, modelGroupMap, groupMap, errors } = resolved;

  if (!isValid) {
    const errorString = errors.join('\n');
    const errorMessage = 'Invalid Azure OpenAI configuration:\n' + errorString;
    logger.error(errorMessage);
    throw new Error(errorMessage);
  }

  for (const modelName of modelNames) {
    mapModelToAzureConfig({ modelName, modelGroupMap, groupMap });
  }

  if (
    lacksAzureAssistantModels({
      assistants: azureConfiguration.assistants,
      assistantModels: resolved.assistantModels,
    })
  ) {
    throw new Error(
      'No Azure models are configured to support assistants. Please remove the `assistants` field or configure at least one model to support assistants.',
    );
  }

  if (
    azureConfiguration.assistants &&
    process.env.ENDPOINTS &&
    !process.env.ENDPOINTS.includes(EModelEndpoint.azureAssistants)
  ) {
    logger.warn(
      `Azure Assistants are configured, but the endpoint will not be accessible as it's not included in the ENDPOINTS environment variable.
      Please add the value "${EModelEndpoint.azureAssistants}" to the ENDPOINTS list if expected.`,
    );
  }

  return {
    errors,
    isValid,
    groupMap,
    modelNames,
    modelGroupMap,
    assistantModels: resolved.assistantModels,
    assistantGroups: resolved.assistantGroups,
    ...azureConfiguration,
  };
}

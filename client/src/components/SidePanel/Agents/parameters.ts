import keyBy from 'lodash/keyBy';
import {
  agentParamSettings,
  applyModelAwareDefaults,
  getEndpointField,
  getSettingsKeys,
  normalizeEndpointName,
  resolveDropParamsUIKeys,
} from 'librechat-data-provider';
import type {
  AgentModelParameters,
  SettingDefinition,
  TEndpointsConfig,
  TStartupConfig,
} from 'librechat-data-provider';

export type AgentParameterConfig = {
  endpointsConfig?: TEndpointsConfig | null;
  startupConfig?: Pick<TStartupConfig, 'endpointsDropParamsMap'> | null;
};

export type ResolvedAgentParameterSettings = {
  /**
   * Every parameter the endpoint schema defines after administrator drops. Pruning reads
   * this, so a value hidden by the model or role is still recognised and preserved:
   * dropping it here would delete another user's configuration on an unrelated
   * save by someone without the permission.
   */
  parameters: SettingDefinition[];
  /** The subset that gets a control. Model-hidden and role-gated parameters are absent. */
  visibleParameters: SettingDefinition[];
  schemaResolved: boolean;
};

const NON_CONTROL_PARAMETER_KEYS = new Set<keyof AgentModelParameters>(['model']);

export function resolveAgentParameterSettings({
  endpointsConfig,
  model,
  provider,
  startupConfig,
  webSearchAllowed,
}: AgentParameterConfig & {
  model: string;
  provider: string;
  /** `WEB_SEARCH.USE`. `web_search` is a default model parameter for the OpenAI,
   *  Anthropic and Google column sets, so without this the builder offers a
   *  switch the server will refuse. Narrows `visibleParameters` only. */
  webSearchAllowed: boolean;
}): ResolvedAgentParameterSettings {
  const resolvedEndpointsConfig = endpointsConfig ?? {};
  const endpointType = getEndpointField(resolvedEndpointsConfig, provider, 'type');
  const customParams = resolvedEndpointsConfig[provider]?.customParams;
  const [combinedKey, endpointKey] = getSettingsKeys(endpointType ?? provider, model);
  const overriddenEndpointKey = customParams?.defaultParamsEndpoint ?? endpointKey;
  const dropParamsMap = startupConfig?.endpointsDropParamsMap;
  const dropParamsEntry =
    dropParamsMap?.[provider] ?? dropParamsMap?.[normalizeEndpointName(provider)];
  const resolvedDropParams = Array.isArray(dropParamsEntry)
    ? dropParamsEntry
    : dropParamsEntry?.[model];
  const dropParamsSet = resolveDropParamsUIKeys(
    Array.isArray(resolvedDropParams) ? resolvedDropParams : undefined,
    overriddenEndpointKey,
  );
  const defaultParams =
    agentParamSettings[combinedKey] ?? agentParamSettings[overriddenEndpointKey];
  const overriddenParams = customParams?.paramDefinitions;
  const overriddenParamsMap = keyBy(overriddenParams ?? [], 'key');
  /** Keep endpoint-recognized keys independent of model visibility. Only explicit
   * administrator drops remove keys from the schema used by both save paths. */
  const endpointParams = (defaultParams ?? []).filter(
    (param) => param != null && !dropParamsSet.has(param.key),
  );
  const applyOverride = (param: SettingDefinition) =>
    (overriddenParamsMap[param.key] as SettingDefinition) ?? param;
  const parameters = endpointParams.map(applyOverride);
  const visibleParameters = applyModelAwareDefaults(
    endpointParams,
    overriddenEndpointKey,
    model,
    resolvedEndpointsConfig[provider]?.responsesApiRouting,
  )
    .map(applyOverride)
    .filter((param) => param.key !== 'web_search' || webSearchAllowed);

  return {
    schemaResolved: defaultParams != null || overriddenParams != null,
    parameters,
    visibleParameters,
  };
}

export function pruneAgentModelParameters(
  currentParameters: AgentModelParameters | undefined,
  settings: ResolvedAgentParameterSettings,
): AgentModelParameters {
  const normalizedParameters = currentParameters ?? ({} as AgentModelParameters);
  if (!settings.schemaResolved) {
    return normalizedParameters;
  }

  const parameterKeys = new Set(settings.parameters.map((setting) => setting.key));
  const currentKeys = Object.keys(normalizedParameters) as Array<keyof AgentModelParameters>;
  let prunedParameters: Partial<AgentModelParameters> | undefined;

  for (const key of currentKeys) {
    if (
      NON_CONTROL_PARAMETER_KEYS.has(key) ||
      parameterKeys.has(key) ||
      normalizedParameters[key] == null
    ) {
      continue;
    }

    prunedParameters ??= { ...normalizedParameters };
    delete prunedParameters[key];
  }

  return (prunedParameters ?? normalizedParameters) as AgentModelParameters;
}

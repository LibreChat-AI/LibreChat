import { Providers } from '@librechat/agents';
import {
  paramSettings,
  agentParamSettings,
  validateSettingDefinitions,
} from 'librechat-data-provider';
import type { TEndpoint } from 'librechat-data-provider';
import { isAgentInferenceExtension } from '~/agents/inference';

type CustomParams = NonNullable<TEndpoint['customParams']>;
type CustomParamDefinition = NonNullable<CustomParams['paramDefinitions']>[number];

const OPENROUTER_PROMPT_CACHE_DEFAULT = {
  key: 'promptCache',
  default: true,
};

function includesOpenRouter(value: string | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase().includes(Providers.OPENROUTER);
}

function isOpenRouterEndpoint(endpoint: TEndpoint): boolean {
  return includesOpenRouter(endpoint.name) || includesOpenRouter(endpoint.baseURL);
}

function shouldPreserveCustomParams(customParams: CustomParams | undefined): boolean {
  const defaultEndpoint = customParams?.defaultParamsEndpoint;
  return (
    !!defaultEndpoint && defaultEndpoint !== 'custom' && defaultEndpoint !== Providers.OPENROUTER
  );
}

/**
 * OpenRouter's parameter defaults for an endpoint named for it or pointing at it, unless its
 * `customParams` take their defaults from another provider: `defaultParamsEndpoint: openrouter`
 * and a `promptCache` definition defaulting to on.
 */
function withOpenRouterDefaults(endpoint: TEndpoint): CustomParams | undefined {
  const { customParams } = endpoint;
  if (!isOpenRouterEndpoint(endpoint) || shouldPreserveCustomParams(customParams)) {
    return customParams;
  }
  const params: CustomParams = customParams ?? { defaultParamsEndpoint: 'custom' };
  const paramDefinitions = params.paramDefinitions ?? [];
  const hasPromptCache = paramDefinitions.some((param) => param.key === 'promptCache');
  return {
    ...params,
    defaultParamsEndpoint: Providers.OPENROUTER,
    paramDefinitions: hasPromptCache
      ? paramDefinitions
      : [...paramDefinitions, OPENROUTER_PROMPT_CACHE_DEFAULT],
  };
}

/**
 * Parameter definitions completed from the defaults of their `defaultParamsEndpoint`, each
 * marked as a custom option. Throws for an unknown `defaultParamsEndpoint`, a key that is neither
 * a parameter of that endpoint nor a valid agent inference extension, or definitions that do not
 * validate.
 */
function expandCustomParams(
  endpointName: string | undefined,
  customParams: CustomParams,
): CustomParams {
  const paramEndpoint = customParams.defaultParamsEndpoint ?? 'custom';
  const paramDefinitions = customParams.paramDefinitions ?? [];

  const validEndpoints = new Set([
    ...Object.keys(paramSettings),
    ...Object.keys(agentParamSettings),
  ]);
  if (!validEndpoints.has(paramEndpoint)) {
    throw new Error(
      `defaultParamsEndpoint of "${endpointName}" endpoint is invalid. ` +
        `Valid options are ${Array.from(validEndpoints).join(', ')}`,
    );
  }

  const regularParams = paramSettings[paramEndpoint] ?? [];
  const agentParams = agentParamSettings[paramEndpoint] ?? [];
  const defaultParams = regularParams.concat(agentParams);
  const defaultParamsMap = new Map(
    defaultParams.map((param) => [param.key, param as CustomParamDefinition]),
  );
  const invalidKeys = paramDefinitions
    .filter((param) => !defaultParamsMap.has(param.key) && !isAgentInferenceExtension(param))
    .map((param) => param.key);
  if (invalidKeys.length > 0) {
    throw new Error(
      `paramDefinitions of "${endpointName}" endpoint contains invalid key(s). ` +
        `Valid parameter keys are ${Array.from(defaultParamsMap.keys()).join(', ')}`,
    );
  }

  const parsedDefinitions = paramDefinitions.map((param) => ({
    ...defaultParamsMap.get(param.key),
    ...param,
    optionType: 'custom',
  })) as CustomParamDefinition[];

  try {
    validateSettingDefinitions(
      parsedDefinitions as Parameters<typeof validateSettingDefinitions>[0],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Custom parameter definitions for "${endpointName}" endpoint is malformed: ${message}`,
    );
  }

  return {
    ...customParams,
    defaultParamsEndpoint: paramEndpoint,
    paramDefinitions: parsedDefinitions,
  };
}

/**
 * A custom endpoint as the runtime serves it from its librechat.yaml form: OpenRouter's defaults
 * added for an endpoint named for it or pointing at it, and its `customParams` expanded (each
 * compact parameter definition completed from the defaults of `defaultParamsEndpoint`). Returns
 * a copy and never changes `endpoint`; expanding an expanded endpoint returns an equal one. Throws
 * when the parameter definitions are invalid, as loading librechat.yaml does.
 */
export function expandCustomEndpoint(endpoint: TEndpoint): TEndpoint {
  const customParams = withOpenRouterDefaults(endpoint);
  if (customParams == null) {
    return { ...endpoint };
  }
  return { ...endpoint, customParams: expandCustomParams(endpoint.name, customParams) };
}

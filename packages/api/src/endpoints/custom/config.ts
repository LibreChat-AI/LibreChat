import {
  ProviderId,
  EModelEndpoint,
  extractEnvVariable,
  normalizeEndpointName,
  reasoningSettingKeys,
  hasExplicitReasoningEffort,
  ReasoningParameterFormat,
} from 'librechat-data-provider';
import type { TCustomEndpoints, TEndpoint } from 'librechat-data-provider';
import type { TCustomEndpointsConfig } from '~/types/endpoints';
import { resolveEndpointProviderId, providerFromBaseURL } from './providers';
import { isUserProvided } from '~/utils';

/**
 * Backend params whose removal also removes the effort an OpenRouter endpoint would advertise.
 */
const reasoningDropParams: ReadonlySet<string> = new Set(['reasoning_effort', 'reasoning']);

type CustomParams = NonNullable<TEndpoint['customParams']>;

/**
 * Whether an endpoint is OpenRouter's, from its resolved base URL host or from the administrator
 * marking its parameter set as OpenRouter's (a proxy in front of OpenRouter has another host). A
 * name or icon says nothing about what the server behind it accepts, so neither counts. Anything
 * the administrator stated wins: a native `provider`, another params endpoint, or disabled
 * reasoning. Only OpenRouter takes an effort for every model it serves: OpenAI and xAI depend on the
 * model (gpt-4o takes no effort, grok-4.6 and grok-4.7 take different sets, GPT-5.6 with tools
 * needs a Responses route a custom endpoint does not get), and this is decided per endpoint, before
 * a model is chosen.
 */
export function isOpenRouterEndpoint(
  endpoint: Pick<TEndpoint, 'provider' | 'customParams'>,
  resolvedBaseURL: string,
): boolean {
  const params = endpoint.customParams as Partial<CustomParams> | undefined;
  if (endpoint.provider != null || params?.reasoningFormat === ReasoningParameterFormat.disabled) {
    return false;
  }
  const paramsEndpoint = params?.defaultParamsEndpoint;
  if (paramsEndpoint === ProviderId.openrouter) {
    return true;
  }
  const generic = paramsEndpoint == null || paramsEndpoint === EModelEndpoint.custom;
  return generic && providerFromBaseURL(resolvedBaseURL) === ProviderId.openrouter;
}

/**
 * Whether the endpoint's reasoning efforts come from OpenRouter's per-model catalog: the one rule
 * the config marking, the catalog loader and the stored-effort check share, so the client's
 * decision to fetch and the server's decision to read cannot disagree. An administrator-defined
 * `reasoning_effort` is authoritative, so the catalog could change no result, and an endpoint that
 * drops the effort never sends it.
 */
export function usesOpenRouterCatalog(
  endpoint: Pick<TEndpoint, 'provider' | 'customParams' | 'dropParams'>,
  resolvedBaseURL: string,
): boolean {
  return (
    isOpenRouterEndpoint(endpoint, resolvedBaseURL) &&
    !hasExplicitReasoningEffort(endpoint.customParams?.paramDefinitions) &&
    endpoint.dropParams?.some((param) => reasoningDropParams.has(param)) !== true
  );
}

/**
 * Declares reasoning support for an OpenRouter endpoint so the effort control appears without
 * per-endpoint config, and marks the endpoint's parameter set as OpenRouter's so the client knows to
 * read the catalog. The marking comes from the resolved host: the config loader only sees the
 * unresolved name and URL. A `reasoningFormat` the administrator set is kept, and reasoning
 * parameter definitions suppress only the format. An endpoint that drops the effort is left alone.
 */
function withOpenRouterReasoning(
  endpoint: Pick<TEndpoint, 'provider' | 'customParams' | 'dropParams'>,
  resolvedBaseURL: string,
): TEndpoint['customParams'] {
  const customParams = endpoint.customParams;
  if (
    !isOpenRouterEndpoint(endpoint, resolvedBaseURL) ||
    endpoint.dropParams?.some((param) => reasoningDropParams.has(param)) === true
  ) {
    return customParams;
  }
  const params = (customParams ?? {}) as Partial<CustomParams>;
  const declaresReasoning = params.paramDefinitions?.some((setting) =>
    reasoningSettingKeys.some((key) => key === setting.key),
  );
  return {
    ...params,
    defaultParamsEndpoint: ProviderId.openrouter,
    ...(params.reasoningFormat == null &&
      declaresReasoning !== true && {
        reasoningFormat: ReasoningParameterFormat.reasoningEffort,
      }),
  } as TEndpoint['customParams'];
}

/**
 * Load config endpoints from the cached configuration object
 * @param customEndpointsConfig - The configuration object
 */
export function loadCustomEndpointsConfig(
  customEndpoints?: TCustomEndpoints,
): TCustomEndpointsConfig | undefined {
  if (!customEndpoints) {
    return;
  }

  const customEndpointsConfig: TCustomEndpointsConfig = {};

  if (Array.isArray(customEndpoints)) {
    const filteredEndpoints = customEndpoints.filter(
      (endpoint) =>
        endpoint.baseURL &&
        endpoint.apiKey &&
        endpoint.name &&
        endpoint.models &&
        (endpoint.models.fetch || endpoint.models.default),
    );

    for (let i = 0; i < filteredEndpoints.length; i++) {
      const endpoint = filteredEndpoints[i] as TEndpoint;
      const {
        baseURL,
        apiKey,
        name: configName,
        iconURL,
        modelDisplayLabel,
        customParams,
        provider,
        dropParams,
      } = endpoint;
      const name = normalizeEndpointName(configName);

      const resolvedApiKey = extractEnvVariable(apiKey ?? '');
      const resolvedBaseURL = extractEnvVariable(baseURL ?? '');
      const userProvideURL = isUserProvided(resolvedBaseURL);

      /**
       * A native `provider` (e.g. anthropic) implies its parameter set. Surface it
       * as `defaultParamsEndpoint` so the client param panel shows the right fields
       * (e.g. `maxOutputTokens`/`thinking` for Anthropic, not OpenAI `max_tokens`),
       * unless an admin explicitly chose a non-default `defaultParamsEndpoint`.
       */
      const resolvedCustomParams =
        provider != null &&
        (customParams?.defaultParamsEndpoint == null ||
          customParams.defaultParamsEndpoint === EModelEndpoint.custom)
          ? { ...customParams, defaultParamsEndpoint: provider }
          : withOpenRouterReasoning({ provider, customParams, dropParams }, resolvedBaseURL);

      customEndpointsConfig[name] = {
        type: EModelEndpoint.custom,
        userProvide: isUserProvided(resolvedApiKey) || userProvideURL,
        userProvideURL,
        customParams: resolvedCustomParams,
        modelDisplayLabel,
        iconURL,
        providerId: resolveEndpointProviderId({
          name,
          baseURL: resolvedBaseURL,
          iconURL,
          provider,
        }),
      };
    }
  }

  return customEndpointsConfig;
}

import {
  ProviderId,
  EModelEndpoint,
  extractEnvVariable,
  normalizeEndpointName,
  reasoningSettingKeys,
  ReasoningParameterFormat,
} from 'librechat-data-provider';
import type { TCustomEndpoints, TEndpoint } from 'librechat-data-provider';
import type { TCustomEndpointsConfig } from '~/types/endpoints';
import { resolveEndpointProviderId, providerFromBaseURL } from './providers';
import { isUserProvided } from '~/utils';

/**
 * Hosts whose Chat Completions API takes a flat `reasoning_effort` (OpenRouter
 * takes it as `reasoning.effort`, which the OpenRouter path builds itself).
 * Matched on the base URL host only: a name or icon says nothing about what the
 * server behind it accepts.
 */
const effortReasoningHosts: ReadonlySet<ProviderId> = new Set([
  ProviderId.openrouter,
  ProviderId.openai,
  ProviderId.xai,
]);

type CustomParams = NonNullable<TEndpoint['customParams']>;

/**
 * Declares reasoning support for a known host so the effort control appears
 * without per-endpoint config. Anything the admin stated wins: a native
 * `provider`, a non-default `defaultParamsEndpoint`, a `reasoningFormat`
 * (including `disabled`), or reasoning parameter definitions.
 */
function withHostReasoning(
  customParams: TEndpoint['customParams'],
  baseURL: string,
  provider?: string,
): TEndpoint['customParams'] {
  const host = providerFromBaseURL(baseURL);
  if (provider != null || host == null || !effortReasoningHosts.has(host)) {
    return customParams;
  }
  const params = (customParams ?? {}) as Partial<CustomParams>;
  const declaresReasoning = params.paramDefinitions?.some((setting) =>
    reasoningSettingKeys.some((key) => key === setting.key),
  );
  const paramsEndpoint = params.defaultParamsEndpoint;
  if (
    params.reasoningFormat != null ||
    declaresReasoning === true ||
    (paramsEndpoint != null && paramsEndpoint !== EModelEndpoint.custom)
  ) {
    return customParams;
  }
  return {
    ...params,
    reasoningFormat: ReasoningParameterFormat.reasoningEffort,
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
          : withHostReasoning(customParams, resolvedBaseURL, provider);

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

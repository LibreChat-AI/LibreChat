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
 * Hosts that accept an effort for any model they serve. OpenRouter takes it as
 * `reasoning.effort`, which the OpenRouter request path builds itself. Matched on
 * the base URL host only: a name or icon says nothing about what the server
 * behind it accepts.
 *
 * OpenAI and xAI are excluded on purpose. Their support and allowed values depend
 * on the model (gpt-4o takes no effort, grok-4.6 and grok-4.7 take different
 * sets, GPT-5.6 with tools needs the Responses route a custom endpoint does not
 * get), and this inference is made per endpoint, before a model is chosen.
 */
const effortReasoningHosts: ReadonlySet<ProviderId> = new Set([ProviderId.openrouter]);

/** Backend params whose removal also removes the effort this inference would advertise. */
const reasoningDropParams: ReadonlySet<string> = new Set(['reasoning_effort', 'reasoning']);

type CustomParams = NonNullable<TEndpoint['customParams']>;

/**
 * Declares reasoning support for a known host so the effort control appears
 * without per-endpoint config, and marks the endpoint's parameter set as OpenRouter's. Anything
 * the admin stated wins: a native
 * `provider`, a non-default `defaultParamsEndpoint`, a `reasoningFormat`
 * (including `disabled`), or reasoning parameter definitions. An endpoint that
 * drops the effort before sending it is not advertised as supporting it.
 */
function withHostReasoning(
  customParams: TEndpoint['customParams'],
  baseURL: string,
  provider?: string,
  dropParams?: string[],
): TEndpoint['customParams'] {
  const host = providerFromBaseURL(baseURL);
  if (
    provider != null ||
    host == null ||
    !effortReasoningHosts.has(host) ||
    dropParams?.some((param) => reasoningDropParams.has(param)) === true
  ) {
    return customParams;
  }
  const params = (customParams ?? {}) as Partial<CustomParams>;
  const declaresReasoning = params.paramDefinitions?.some((setting) =>
    reasoningSettingKeys.some((key) => key === setting.key),
  );
  const paramsEndpoint = params.defaultParamsEndpoint;
  if (
    params.reasoningFormat != null ||
    (paramsEndpoint != null &&
      paramsEndpoint !== EModelEndpoint.custom &&
      paramsEndpoint !== ProviderId.openrouter)
  ) {
    return customParams;
  }
  /** The resolved host is what identifies OpenRouter. The config loader only sees the unresolved
   *  name and URL, so an endpoint whose URL comes from an environment variable and whose name does
   *  not say OpenRouter reaches here unmarked, and the client could not tell it uses a catalog. */
  return {
    ...params,
    defaultParamsEndpoint: ProviderId.openrouter,
    ...(declaresReasoning !== true && {
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
          : withHostReasoning(customParams, resolvedBaseURL, provider, dropParams);

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

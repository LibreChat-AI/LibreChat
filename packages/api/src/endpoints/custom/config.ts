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
 * the administrator stated wins: a native `provider` or another params endpoint. Disabling
 * reasoning does not change the endpoint's identity or caching controls.
 */
export function isOpenRouterEndpoint(
  endpoint: Pick<TEndpoint, 'provider' | 'customParams'>,
  resolvedBaseURL: string,
): boolean {
  const params = endpoint.customParams as Partial<CustomParams> | undefined;
  if (endpoint.provider != null) {
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
    endpoint.customParams?.reasoningFormat !== ReasoningParameterFormat.disabled &&
    !hasExplicitReasoningEffort(endpoint.customParams?.paramDefinitions) &&
    endpoint.dropParams?.some((param) => reasoningDropParams.has(param)) !== true
  );
}

/**
 * Preserve the OpenRouter parameter profile independently of its reasoning capability.
 * Drops disable reasoning advertisement, not caching; explicit formats and definitions otherwise win.
 */
function withOpenRouterReasoning(
  endpoint: Pick<TEndpoint, 'provider' | 'customParams' | 'dropParams'>,
  resolvedBaseURL: string,
): TEndpoint['customParams'] {
  const customParams = endpoint.customParams;
  if (!isOpenRouterEndpoint(endpoint, resolvedBaseURL)) {
    return customParams;
  }
  const params = (customParams ?? {}) as Partial<CustomParams>;
  const dropsReasoning = endpoint.dropParams?.some((param) => reasoningDropParams.has(param));
  const declaresReasoning = params.paramDefinitions?.some((setting) =>
    reasoningSettingKeys.some((key) => key === setting.key),
  );
  return {
    ...params,
    defaultParamsEndpoint: ProviderId.openrouter,
    ...(dropsReasoning === true && { reasoningFormat: ReasoningParameterFormat.disabled }),
    ...(dropsReasoning !== true &&
      params.reasoningFormat == null &&
      declaresReasoning !== true && {
        reasoningFormat: ReasoningParameterFormat.reasoningEffort,
      }),
  } as TEndpoint['customParams'];
}

/** The trusted parameter profile shared by discovery, write validation, and execution. */
export function resolveCustomEndpointParameters(
  endpoint: Pick<TEndpoint, 'provider' | 'customParams' | 'dropParams'>,
  resolvedBaseURL: string,
): TEndpoint['customParams'] {
  const { provider, customParams } = endpoint;
  if (
    provider != null &&
    (customParams?.defaultParamsEndpoint == null ||
      customParams.defaultParamsEndpoint === EModelEndpoint.custom)
  ) {
    return { ...customParams, defaultParamsEndpoint: provider };
  }
  return withOpenRouterReasoning(endpoint, resolvedBaseURL);
}

/** A custom endpoint definition the endpoint and model loaders serve. */
export type ServedCustomEndpoint = Partial<TEndpoint> &
  Pick<TEndpoint, 'name' | 'apiKey' | 'baseURL'>;

/**
 * Whether the endpoint and model loaders serve a custom endpoint definition: it names its base
 * URL and API key, and a model list or a fetch.
 */
export function isServedCustomEndpoint(
  endpoint: Partial<TEndpoint>,
): endpoint is ServedCustomEndpoint {
  return Boolean(
    endpoint.baseURL &&
      endpoint.apiKey &&
      endpoint.name &&
      endpoint.models &&
      (endpoint.models.fetch || endpoint.models.default),
  );
}

/**
 * The definition each served custom endpoint name resolves to, by served name (`Ollama` is served
 * as `ollama`): the last served definition of that name, which is the one `/api/endpoints` reports.
 * Names keep the order they are first served in.
 */
export function resolveServedCustomEndpoints(
  endpoints: readonly Partial<TEndpoint>[],
): Map<string, ServedCustomEndpoint> {
  const served = new Map<string, ServedCustomEndpoint>();
  for (const endpoint of endpoints) {
    if (isServedCustomEndpoint(endpoint)) {
      served.set(normalizeEndpointName(endpoint.name), endpoint);
    }
  }
  return served;
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
    for (const [name, endpoint] of resolveServedCustomEndpoints(customEndpoints)) {
      const { baseURL, apiKey, iconURL, modelDisplayLabel, customParams, provider, dropParams } =
        endpoint;

      const resolvedApiKey = extractEnvVariable(apiKey);
      const resolvedBaseURL = extractEnvVariable(baseURL);
      const userProvideURL = isUserProvided(resolvedBaseURL);

      /**
       * A native `provider` (e.g. anthropic) implies its parameter set. Surface it
       * as `defaultParamsEndpoint` so the client param panel shows the right fields
       * (e.g. `maxOutputTokens`/`thinking` for Anthropic, not OpenAI `max_tokens`),
       * unless an admin explicitly chose a non-default `defaultParamsEndpoint`.
       */
      const resolvedCustomParams = resolveCustomEndpointParameters(
        { provider, customParams, dropParams },
        resolvedBaseURL,
      );

      customEndpointsConfig[name] = {
        type: EModelEndpoint.custom,
        visible: endpoint.visible ?? true,
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

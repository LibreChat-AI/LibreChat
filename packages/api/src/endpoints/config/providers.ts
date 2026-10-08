import { Providers } from '@librechat/agents';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { InitializeResultBase, ProviderInitializeParams } from '~/types';
import { resolveCustomEndpointSecrets } from '~/admin/secrets';
import { initializeAnthropic } from '../anthropic/initialize';
import { initializeBedrock } from '../bedrock/initialize';
import { initializeCustom } from '../custom/initialize';
import { initializeGoogle } from '../google/initialize';
import { initializeOpenAI } from '../openai/initialize';
import { getCustomEndpointConfig } from '~/app/config';

/**
 * Type for initialize functions
 */
export type InitializeFn = (params: ProviderInitializeParams) => Promise<InitializeResultBase>;

/**
 * Check if the provider is a known custom provider
 * @param provider - The provider string
 * @returns True if the provider is a known custom provider, false otherwise
 */
export function isKnownCustomProvider(provider?: string): boolean {
  return [Providers.XAI, Providers.DEEPSEEK, Providers.OPENROUTER, Providers.MOONSHOT].includes(
    (provider?.toLowerCase() ?? '') as Providers,
  );
}

/**
 * Provider configuration map mapping providers to their initialization functions.
 *
 * `Providers.VERTEXAI` shares `initializeGoogle` because the runtime distinction
 * is auth-only — the agent flow may resolve `agent.provider` to `vertexai` when
 * a service account is configured, but summarization (and other downstream
 * resolvers) get the same lowercase enum value passed back. Without this
 * mapping `getProviderConfig` throws "Provider vertexai not supported" and
 * summarization falls back to the raw provider, dropping client overrides.
 */
export const providerConfigMap: Record<string, InitializeFn> = {
  [Providers.XAI]: initializeCustom,
  [Providers.DEEPSEEK]: initializeCustom,
  [Providers.MOONSHOT]: initializeCustom,
  [Providers.OPENROUTER]: initializeCustom,
  [Providers.VERTEXAI]: initializeGoogle,
  [EModelEndpoint.openAI]: initializeOpenAI,
  [EModelEndpoint.google]: initializeGoogle,
  [EModelEndpoint.bedrock]: initializeBedrock,
  [EModelEndpoint.azureOpenAI]: initializeOpenAI,
  [EModelEndpoint.anthropic]: initializeAnthropic,
};

export type TitleTiming = 'immediate' | 'final';

/**
 * Resolves when conversation titles are generated for a given endpoint.
 *
 * `endpoints.all.titleTiming`, when present, is the global override. Otherwise,
 * endpoint candidates are checked in order so the public endpoint (for example
 * `agents`) can override the backing provider, with provider/custom config used
 * as a fallback. Resolving custom providers via `getProviderConfig` picks up its
 * case-insensitive fallback for normalized provider names (e.g. `openrouter` →
 * `OpenRouter`). Defaults to `immediate`.
 */
export function resolveTitleTiming({
  appConfig,
  endpoint,
}: {
  appConfig?: AppConfig;
  endpoint?: string | Array<string | undefined>;
}): TitleTiming {
  const endpoints = appConfig?.endpoints;
  const resolveConfiguredTiming = (config?: Partial<TEndpoint>): TitleTiming | undefined =>
    config?.titleTiming === 'final' || config?.titleTiming === 'immediate'
      ? config.titleTiming
      : undefined;

  const globalTiming = resolveConfiguredTiming(endpoints?.all);
  if (globalTiming) {
    return globalTiming;
  }

  const endpointCandidates = (Array.isArray(endpoint) ? endpoint : [endpoint]).filter(
    (value): value is string => !!value,
  );

  for (const endpointCandidate of endpointCandidates) {
    const endpointConfig = endpoints?.[endpointCandidate as keyof NonNullable<typeof endpoints>] as
      | Partial<TEndpoint>
      | undefined;
    const endpointTiming = resolveConfiguredTiming(endpointConfig);
    if (endpointTiming) {
      return endpointTiming;
    }
  }

  for (const endpointCandidate of endpointCandidates) {
    if (!appConfig) {
      continue;
    }
    try {
      const providerTiming = resolveConfiguredTiming(
        getProviderConfig({ provider: endpointCandidate, appConfig }).customEndpointConfig,
      );
      if (providerTiming) {
        return providerTiming;
      }
    } catch {
      // Unsupported providers fall back to the default timing.
    }
  }

  return 'immediate';
}

/**
 * Result from getProviderConfig
 */
export interface ProviderConfigResult {
  /** The initialization function for this provider */
  getOptions: InitializeFn;
  /** The resolved provider name (may be different from input if normalized) */
  overrideProvider: string;
  /** Custom endpoint configuration (if applicable) */
  customEndpointConfig?: Partial<TEndpoint>;
}

/**
 * Get the provider configuration and override endpoint based on the provider string
 *
 * @param params - Configuration parameters
 * @param params.provider - The provider string
 * @param params.appConfig - The application configuration
 * @returns Provider configuration including getOptions function, override provider, and custom config
 * @throws Error if provider is not supported
 */
export function getProviderConfig({
  provider,
  appConfig,
}: {
  provider: string;
  appConfig?: AppConfig;
}): ProviderConfigResult {
  let getOptions = providerConfigMap[provider];
  let overrideProvider = provider;
  let customEndpointConfig: Partial<TEndpoint> | undefined;

  if (!getOptions && providerConfigMap[provider.toLowerCase()] != null) {
    overrideProvider = provider.toLowerCase();
    getOptions = providerConfigMap[overrideProvider];
  } else if (!getOptions) {
    customEndpointConfig = getCustomEndpointConfig({ endpoint: provider, appConfig });
    if (!customEndpointConfig) {
      throw new Error(`Provider ${provider} not supported`);
    }
    getOptions = initializeCustom;
    overrideProvider = Providers.OPENAI;
  }

  if (isKnownCustomProvider(overrideProvider) && !customEndpointConfig) {
    customEndpointConfig = getCustomEndpointConfig({ endpoint: provider, appConfig });
    if (!customEndpointConfig && appConfig) {
      /**
       * Case-insensitive fallback for known custom providers only.
       *
       * The agent main flow looks up custom endpoints case-sensitively
       * (case-preserving keys are how `loadCustomEndpointsConfig` lets
       * users have e.g. `"OpenRouter"` and `"openrouter-staging"` as
       * distinct entries). After it succeeds, `agent.provider` is
       * normalized to the lowercase `Providers` enum value
       * (e.g. `"openrouter"`). Downstream resolvers (summarization,
       * title) re-enter `getProviderConfig` with that lowercase value,
       * and the case-sensitive direct lookup misses configs whose
       * `name` is camel-cased — the most common shape.
       *
       * Only fall back when the direct lookup already failed, so users
       * with case-sensitive endpoint identity are unaffected — their
       * exact-case match wins first. When multiple case-insensitive
       * matches exist (e.g. both `OpenRouter` and `OPENROUTER`, neither
       * lowercase), refuse to silently pick array-first; the caller's
       * intent is ambiguous and either entry could route requests with
       * different baseURL/apiKey.
       */
      const customEndpoints = appConfig.endpoints?.[EModelEndpoint.custom] ?? [];
      const target = provider.toLowerCase();
      const matches = customEndpoints.filter(
        (endpointConfig) => (endpointConfig.name ?? '').toLowerCase() === target,
      );
      if (matches.length > 1) {
        const names = matches.map((m) => m.name ?? '').join(', ');
        throw new Error(
          `Provider ${provider} is ambiguous: multiple custom endpoints match case-insensitively (${names}). Rename one or use the exact-case provider value.`,
        );
      }
      customEndpointConfig = matches[0] && resolveCustomEndpointSecrets(matches[0]);
    }
    if (!customEndpointConfig) {
      throw new Error(`Provider ${provider} not supported`);
    }
  }

  /**
   * Custom endpoints default to the OpenAI-compatible client. An explicit
   * `provider: anthropic` routes them through the native Anthropic `/v1/messages`
   * client (`initializeCustom` builds the right config). Applied here — after all
   * `customEndpointConfig` resolution — so it also wins when the endpoint name
   * collides with a known custom-provider (e.g. `openrouter`), ensuring
   * `overrideProvider`-derived values (token/context budget) use the Anthropic map.
   */
  if (customEndpointConfig?.provider === EModelEndpoint.anthropic) {
    overrideProvider = Providers.ANTHROPIC;
  }

  return {
    getOptions,
    overrideProvider,
    customEndpointConfig,
  };
}

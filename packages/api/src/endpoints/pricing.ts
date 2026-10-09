import { EModelEndpoint } from 'librechat-data-provider';
import type { TModelsConfig, TTokenConfigMap, TModelTokenomics } from 'librechat-data-provider';
import type { TxMethods } from '@librechat/data-schemas';
import type { EndpointTokenConfig } from '~/types';
import { getModelMaxTokens, maxTokensMap } from '~/utils';

export interface TokenomicsDeps {
  getValueKey: TxMethods['getValueKey'];
  getMultiplier: TxMethods['getMultiplier'];
  getCacheMultiplier: TxMethods['getCacheMultiplier'];
}

export interface TokenConfigParams {
  /** endpoint → model list, from the resolved models config */
  modelsConfig: TModelsConfig;
  /** Per-endpoint overrides: fetched (e.g. OpenRouter) or yaml `tokenConfig` */
  endpointTokenConfigs?: Record<string, EndpointTokenConfig | undefined>;
  /** Include USD-per-1M rates; gated by `interface.contextCost` */
  includePricing?: boolean;
}

/**
 * Resolves context windows (and optionally pricing) for every configured
 * model, server-side, so the client never reimplements pattern matching.
 */
export function buildTokenConfigMap(
  params: TokenConfigParams,
  deps: TokenomicsDeps,
): TTokenConfigMap {
  const { modelsConfig, endpointTokenConfigs, includePricing = false } = params;
  const map: TTokenConfigMap = {};

  for (const [endpoint, models] of Object.entries(modelsConfig)) {
    if (!Array.isArray(models) || models.length === 0) {
      continue;
    }
    const override = endpointTokenConfigs?.[endpoint];
    const endpointKey = (
      maxTokensMap[endpoint] != null ? endpoint : EModelEndpoint.custom
    ) as EModelEndpoint;

    const entry: Record<string, TModelTokenomics> = {};
    for (const model of models) {
      const tokenomics: TModelTokenomics = {};
      /** getModelMaxTokens falls back to the built-in map for models absent
       *  from a partial override, so a single call covers both cases. */
      const context = getModelMaxTokens(model, endpointKey, override);
      if (context != null) {
        tokenomics.context = context;
      }

      if (includePricing) {
        const overrideRates = override?.[model];
        if (overrideRates?.prompt != null || overrideRates?.completion != null) {
          tokenomics.prompt = overrideRates.prompt;
          tokenomics.completion = overrideRates.completion;
          /** Carry admin-configured cache rates; client falls back to the
           *  prompt rate for whichever cache rate is absent */
          if (overrideRates.cacheWrite != null) {
            tokenomics.cacheWrite = overrideRates.cacheWrite;
          }
          if (overrideRates.cacheRead != null) {
            tokenomics.cacheRead = overrideRates.cacheRead;
          }
        } else {
          const valueKey = deps.getValueKey(model, endpoint);
          tokenomics.prompt = deps.getMultiplier({
            valueKey,
            model,
            endpoint,
            tokenType: 'prompt',
          });
          tokenomics.completion = deps.getMultiplier({
            valueKey,
            model,
            endpoint,
            tokenType: 'completion',
          });
          const cacheWrite = deps.getCacheMultiplier({
            valueKey,
            model,
            endpoint,
            cacheType: 'write',
          });
          const cacheRead = deps.getCacheMultiplier({
            valueKey,
            model,
            endpoint,
            cacheType: 'read',
          });
          if (cacheWrite != null) {
            tokenomics.cacheWrite = cacheWrite;
          }
          if (cacheRead != null) {
            tokenomics.cacheRead = cacheRead;
          }
        }
      }

      entry[model] = tokenomics;
    }
    map[endpoint] = entry;
  }

  return map;
}

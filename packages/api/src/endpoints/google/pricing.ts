import { isGeminiHydrogen, getGeminiHydrogenRates } from 'librechat-data-provider';
import type { TGoogleTokenConfig } from 'librechat-data-provider';
import type { EndpointTokenConfig } from '~/types';

/** Resolve operator rates identically for usage billing and the context-cost display. */
export function getGoogleTokenConfig(
  model: string,
  configured?: TGoogleTokenConfig,
  location?: string,
): EndpointTokenConfig[string] | undefined {
  const bareModel = model.replace(/^models\//, '');
  const keys = [model, bareModel, `models/${bareModel}`];
  const key = keys.find(
    (candidate) => configured && Object.prototype.hasOwnProperty.call(configured, candidate),
  );
  const rates = key == null ? undefined : configured?.[key];
  if (rates) {
    return { ...rates, read: rates.cacheRead };
  }
  if (!isGeminiHydrogen(model)) {
    return undefined;
  }
  const standard = getGeminiHydrogenRates(location);
  return { ...standard, cacheRead: standard.read };
}

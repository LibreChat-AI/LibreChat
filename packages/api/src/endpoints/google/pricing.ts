import type { TGoogleTokenConfig } from 'librechat-data-provider';
import type { EndpointTokenConfig } from '~/types';

/** Resolve operator rates identically for usage billing and the context-cost display. */
export function getGoogleTokenConfig(
  model: string,
  configured?: TGoogleTokenConfig,
): EndpointTokenConfig[string] | undefined {
  if (!configured) {
    return undefined;
  }
  const bareModel = model.replace(/^models\//, '');
  const keys = [model, bareModel, `models/${bareModel}`];
  const key = keys.find((candidate) => Object.prototype.hasOwnProperty.call(configured, candidate));
  const rates = key == null ? undefined : configured[key];
  return rates == null ? undefined : { ...rates, read: rates.cacheRead };
}

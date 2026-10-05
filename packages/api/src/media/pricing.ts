import { normalizeEndpointName } from 'librechat-data-provider';
import type { AppConfig, MediaTokenPricing, TxMethods } from '@librechat/data-schemas';
import type { MediaIntegration } from 'librechat-data-provider';

export type MediaPricing = Pick<
  TxMethods,
  'getMultiplier' | 'getValueKey' | 'tokenValues' | 'imageTokenValues' | 'premiumTokenValues'
>;

const RELEASE_SUFFIX = /(?:-(?:preview|latest|exp|\d+))+$/;

/**
 * Substring lookup is right for chat, but it prices `gemini-3.1-flash-image` as the `gemini-3.1`
 * text model. A media match must name the whole model apart from its vendor path and release tag.
 */
function namesModel(model: string, valueKey: string): boolean {
  const name = model.toLowerCase().slice(model.lastIndexOf('/') + 1);
  return name === valueKey || name.replace(RELEASE_SUFFIX, '') === valueKey;
}

/** Resolves only explicitly priced models, freezing rates before a durable job is admitted. */
export function snapshotMediaPricing(
  pricing: MediaPricing,
  model: string,
  integration: MediaIntegration,
  appConfig: AppConfig,
): MediaTokenPricing | undefined {
  const endpointName =
    integration.endpointRef.kind === 'custom'
      ? normalizeEndpointName(integration.endpointRef.name)
      : undefined;
  const endpointTokenConfig = endpointName
    ? appConfig.endpoints?.custom?.find(
        (endpoint) => normalizeEndpointName(endpoint.name) === endpointName,
      )?.tokenConfig
    : undefined;
  const override = endpointTokenConfig?.[model];
  const imageModel = model.replace(/^openai\//, '');
  if (integration.api === 'openai.images' && /^gpt-image-/.test(imageModel)) {
    const explicitImage = override ?? pricing.imageTokenValues[imageModel];
    if (!explicitImage) return;
    const snapshot = {
      source: override ? ('endpointTokenConfig' as const) : ('imageTokenValues' as const),
      valueKey: override ? model : imageModel,
      prompt: explicitImage.prompt,
      completion: explicitImage.completion,
      imagePrompt: explicitImage.imagePrompt ?? explicitImage.prompt,
      cacheRead: explicitImage.cacheRead ?? explicitImage.prompt,
      imageCacheRead:
        explicitImage.imageCacheRead ?? explicitImage.imagePrompt ?? explicitImage.prompt,
    };
    if (
      [
        snapshot.prompt,
        snapshot.completion,
        snapshot.imagePrompt,
        snapshot.cacheRead,
        snapshot.imageCacheRead,
      ].some((rate) => !Number.isFinite(rate) || rate < 0)
    )
      return;
    return snapshot;
  }
  // Responses wrappers have separately billed language-model and image-tool usage.
  if (integration.api === 'openai.images') return;
  const matchedKey = override || pricing.tokenValues[model] ? model : pricing.getValueKey(model);
  const valueKey =
    matchedKey && (matchedKey === model || namesModel(model, matchedKey)) ? matchedKey : undefined;
  if (!valueKey || (!override && !pricing.tokenValues[valueKey])) return;
  const explicit = override ?? pricing.tokenValues[valueKey];
  if (![explicit.prompt, explicit.completion].every((rate) => Number.isFinite(rate) && rate >= 0))
    return;
  const rates = (inputTokenCount?: number) => ({
    prompt: pricing.getMultiplier({
      model,
      valueKey,
      tokenType: 'prompt',
      endpointTokenConfig,
      inputTokenCount,
    }),
    completion: pricing.getMultiplier({
      model,
      valueKey,
      tokenType: 'completion',
      endpointTokenConfig,
      inputTokenCount,
    }),
  });
  const premium = override ? undefined : pricing.premiumTokenValues[valueKey];
  return {
    source: override ? 'endpointTokenConfig' : 'tokenValues',
    valueKey,
    ...rates(),
    ...(premium
      ? { premium: { threshold: premium.threshold, ...rates(premium.threshold + 1) } }
      : {}),
  };
}

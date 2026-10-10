/**
 * A GPT point release (`gpt-6.1-sol`) that has no entry of its own inherits its
 * family's (`gpt-6-sol`) context window, pricing and reasoning options, and on
 * the native OpenAI endpoint its Responses routing, so a release works the day a
 * provider ships it. An explicit entry for the release always takes precedence.
 */
const GPT_POINT_RELEASE = /(^|[^a-z0-9])(gpt-\d+)\.\d+(?=-)/i;

/** `gpt-6.1-sol-2026-10-01` → `gpt-6-sol-2026-10-01`; undefined when `model` is not a point release. */
export function gptPointReleaseFamily(model: string): string | undefined {
  if (!GPT_POINT_RELEASE.test(model)) {
    return undefined;
  }
  return model.replace(GPT_POINT_RELEASE, '$1$2');
}

export type Gpt6Tier = 'astra' | 'sol' | 'luna';

const GPT6_TIERS: Record<string, Gpt6Tier> = { astra: 'astra', sol: 'sol', luna: 'luna' };
const GPT6_TIER = /^gpt-6(?:\.\d+)?-(astra|sol|luna)(?=-|$)/i;

/** The GPT-6 tier of `model`, including point releases and snapshots (`gpt-6.1-sol-2026-10-01` → `sol`). */
export function gpt6Tier(model?: string | null): Gpt6Tier | undefined {
  const tier = GPT6_TIER.exec(model ?? '')?.[1];
  return tier == null ? undefined : GPT6_TIERS[tier.toLowerCase()];
}

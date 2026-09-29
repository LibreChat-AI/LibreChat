import {
  isAgentFadingTier,
  isCurrentAgentFadingTier,
  isAgentFadingTierEntry,
  isAgentFadingTierEntries,
  AGENT_FADING_TIER_VERSION,
} from '@librechat/data-schemas';
import type {
  IAgentEventActorContextMeta,
  IAgentFadingTierEntry,
  IAgentFadingTier,
} from '@librechat/data-schemas';

export { isAgentFadingTier, isCurrentAgentFadingTier, isAgentFadingTierEntries };

/** Latched current-version tiers keyed by agent ID for `RunConfig.fadingTiers`. */
export type RunFadingTiers = Record<
  string,
  IAgentFadingTier & { v: typeof AGENT_FADING_TIER_VERSION }
>;

/**
 * Normalizes the tier a run exposes for persistence, or undefined when there
 * is none. `Run.getFadingTier()` already returns only tiers that carry
 * information (masking active, a budget below the pruner's window, or a tier
 * restored from host state), so the host validates the shape and strips
 * anything else the SDK may attach, such as its `latched` provenance flag.
 */
export function resolvePersistableFadingTier(tier: unknown): IAgentFadingTier | undefined {
  if (!isAgentFadingTier(tier)) {
    return undefined;
  }
  return { v: tier.v, budgetTokens: tier.budgetTokens, masked: tier.masked };
}

/**
 * Normalizes the per-agent tiers a run exposes (`Run.getFadingTiers()`) into
 * persisted entries. Only own enumerable keys are read and every tier is
 * validated and stripped, so an agent ID never reaches storage as a field name
 * and nothing beyond the compact tier is persisted.
 */
export function resolvePersistableFadingTiers(tiers: unknown): IAgentFadingTierEntry[] | undefined {
  if (typeof tiers !== 'object' || tiers === null) {
    return undefined;
  }
  const candidates: Array<[string, unknown]> = Object.entries(tiers);
  const entries = candidates.flatMap(([agentId, candidate]) => {
    const tier = resolvePersistableFadingTier(candidate);
    const entry = tier == null ? undefined : { agentId, ...tier };
    return isAgentFadingTierEntry(entry) ? [entry] : [];
  });
  return entries.length > 0 ? entries : undefined;
}

/**
 * Rebuilds `RunConfig.fadingTiers` from current-version entries on a null-prototype
 * record. Legacy v1 tiers stay readable in storage but must be re-derived because
 * the SDK changed the exchange-width calculation. An agent ID such as `__proto__`
 * remains an own key and cannot touch the prototype chain.
 */
export function resolveRunFadingTiers(entries: unknown): RunFadingTiers | undefined {
  if (!isAgentFadingTierEntries(entries) || entries.length === 0) {
    return undefined;
  }
  const tiers: RunFadingTiers = Object.create(null);
  let hasCurrentTier = false;
  for (const { agentId, v, budgetTokens, masked } of entries) {
    if (v !== AGENT_FADING_TIER_VERSION) {
      continue;
    }
    tiers[agentId] = { v, budgetTokens, masked };
    hasCurrentTier = true;
  }
  return hasCurrentTier ? tiers : undefined;
}

export type RunContextMetaParams = {
  calibrationRatio: number;
  fadingTier: unknown;
  /** Per-agent tiers from `Run.getFadingTiers()` or the live graph. */
  fadingTiers?: unknown;
  /** Resolved lazily: only consulted when there is something to persist. */
  getEncoding: () => string;
};

/**
 * Builds the compact `contextMeta` a response message persists from a run, or
 * undefined when neither calibration nor fading carries information. Only the
 * calibration ratio, its encoding and the latched tiers are kept; message
 * content, canonical tool results and projection state never are. A latched
 * tier is persisted even at a neutral calibration ratio, with the ratio
 * recorded as 1 so the stored shape stays valid.
 */
export function resolveRunContextMeta(
  params: RunContextMetaParams,
): IAgentEventActorContextMeta | undefined {
  const { calibrationRatio } = params;
  const fading = resolvePersistableFadingTier(params.fadingTier);
  const fadingTiers = resolvePersistableFadingTiers(params.fadingTiers);
  const calibrated = calibrationRatio > 0 && calibrationRatio !== 1;
  if (!calibrated && fading == null && fadingTiers == null) {
    return undefined;
  }
  return {
    calibrationRatio: calibrationRatio > 0 ? Math.round(calibrationRatio * 1000) / 1000 : 1,
    encoding: params.getEncoding(),
    ...(fading == null ? {} : { fading }),
    ...(fadingTiers == null ? {} : { fadingTiers }),
  };
}

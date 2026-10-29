import { GraphNodeKeys } from '@librechat/agents';
import { tokenValues } from '@librechat/data-schemas';
import type { TTokenUsageEvent } from 'librechat-data-provider';
import type {
  AccountingBasis,
  AccountingModelSource,
  ResponseAccounting,
  ResponseAccountingCall,
} from './types';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { EndpointTokenConfig } from '~/types/tokens';
import type { PricingFns } from '../transactions';
import { aggregateCollectedUsage, computeUsageCostUSD } from '../usage';

export interface AccountingQuote {
  /** Unsigned, non-exponential USD decimal. */
  amount: string;
  basis: AccountingBasis;
}

export interface AccountingCollectorOptions {
  quote?: (usage: UsageMetadata) => AccountingQuote | undefined;
  /** Server-persisted call provenance; retain original quotes rather than repricing past work. */
  seed?: ResponseAccounting;
}

export type AccountingUsage = Omit<UsageMetadata, 'usage_type'> & {
  usage_type?: ResponseAccountingCall['usageType'];
};

interface InvocationMetadata {
  ls_model_name?: string;
  __invoked_model?: string;
  __invoked_provider?: string;
  langgraph_node?: string;
}

interface InvocationContext {
  provider?: string;
  agentId?: string;
  clientOptions?: { model?: string };
}

const decimal = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;

/** Fixed-point addition avoids accumulating binary floating-point USD drift. */
function sumAmounts(amounts: string[]): string {
  const scale = Math.max(0, ...amounts.map((amount) => amount.split('.')[1]?.length ?? 0));
  const total = amounts.reduce((sum, amount) => {
    const [whole, fraction = ''] = amount.split('.');
    return sum + BigInt(whole + fraction.padEnd(scale, '0'));
  }, BigInt(0));
  if (scale === 0) {
    return total.toString();
  }
  const digits = total.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '');
}

function validUsage(usage: UsageMetadata): boolean {
  const counts = [
    usage.input_tokens,
    usage.output_tokens,
    usage.total_tokens,
    ...Object.values(usage.input_token_details ?? {}),
    ...Object.values(usage.output_token_details ?? {}),
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
    usage.cache_write_tokens,
  ];
  return counts.every((value) => value == null || (Number.isSafeInteger(value) && value >= 0));
}

/**
 * Capture actual invocation provenance before the legacy billing contextualizer
 * replaces provider metadata with configured fallbacks. No requested Agent ID
 * or configured model is presented as a provider-reported model.
 */
export function createResponseAccountingCollector(options: AccountingCollectorOptions = {}) {
  const calls: ResponseAccountingCall[] = options.seed?.calls.map((call) => ({ ...call })) ?? [];
  const callIds = new Map<string, string>();
  let conflictingUsage = options.seed?.reason === 'conflicting_usage';

  return {
    record(
      usage: AccountingUsage | undefined,
      metadata?: InvocationMetadata,
      context?: InvocationContext | null,
      callId?: string,
    ): void {
      const model =
        metadata?.ls_model_name ||
        metadata?.__invoked_model ||
        usage?.model ||
        context?.clientOptions?.model;
      const provider = metadata?.__invoked_provider || usage?.provider || context?.provider;
      let modelSource: AccountingModelSource = 'unknown';
      if (metadata?.ls_model_name || metadata?.__invoked_model) {
        modelSource = 'runtime_reported';
      } else if (usage?.model) {
        modelSource = 'provider_reported';
      } else if (context?.clientOptions?.model) {
        modelSource = 'configured';
      }
      const normalized: UsageMetadata = {
        ...usage,
        model,
        provider,
        agentId: context?.agentId || usage?.agentId,
        usage_type: usage?.usage_type === 'subagent' ? 'subagent' : undefined,
      };
      const totals = aggregateCollectedUsage(usage == null ? [] : [normalized]).total;
      const hasUsage = usage?.input_tokens != null && usage?.output_tokens != null;
      const usable = hasUsage && validUsage(normalized);
      let quote: AccountingQuote | undefined;
      const auxiliary =
        usage?.usage_type === 'activity-label' ||
        usage?.usage_type === 'activity-phase' ||
        usage?.usage_type === 'reasoning-label';
      if (usable && !auxiliary) {
        try {
          quote = options.quote?.(normalized);
        } catch {
          // Optional accounting must not fail a successful generation.
        }
      }
      if (quote && (!decimal.test(quote.amount) || quote.amount.length > 64)) {
        quote = undefined;
      }
      let reason: ResponseAccountingCall['reason'] = 'pricing_unavailable';
      if (!hasUsage) {
        reason = 'usage_unavailable';
      } else if (!usable) {
        reason = 'invalid_usage';
      } else if (quote) {
        reason = 'priced';
      }
      const call: ResponseAccountingCall = {
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
        modelSource,
        usageType: metadata?.langgraph_node?.startsWith(GraphNodeKeys.SUMMARIZE)
          ? 'summarization'
          : (usage?.usage_type ?? 'message'),
        inputTokens: usable ? totals.inputTokens : 0,
        outputTokens: usable ? totals.outputTokens : 0,
        cacheReadTokens: usable ? totals.cacheReadTokens : 0,
        cacheWriteTokens: usable
          ? (usage?.input_token_details?.cache_creation ??
            usage?.input_token_details?.cache_write_tokens ??
            usage?.cache_creation_input_tokens ??
            usage?.cache_write_tokens ??
            0)
          : 0,
        ...(quote ? quote : {}),
        reason,
      };
      // Only a model response's stable ID is a dedupe key. An Agent/run ID
      // would discard distinct sequential calls and under-report the bill.
      if (callId) {
        const serialized = JSON.stringify(call);
        const previous = callIds.get(callId);
        if (previous != null) {
          conflictingUsage ||= previous !== serialized;
          return;
        }
        callIds.set(callId, serialized);
      }
      calls.push(call);
    },
    snapshot(): ResponseAccounting {
      const priced = calls.filter((call) => call.amount != null);
      const bases = new Set(priced.map((call) => call.basis));
      const complete = calls.length > 0 && priced.length === calls.length;
      const available = complete && bases.size === 1 && !conflictingUsage;
      let coverage: ResponseAccounting['coverage'] = 'none';
      if (complete) {
        coverage = 'complete';
      } else if (priced.length > 0) {
        coverage = 'partial';
      }
      let reason: ResponseAccounting['reason'] = 'pricing_unavailable';
      if (conflictingUsage) {
        reason = 'conflicting_usage';
      } else if (available) {
        reason = 'priced';
      } else if (bases.size > 1) {
        reason = 'mixed_bases';
      } else if (calls.length === 0 || calls.every((call) => call.reason === 'usage_unavailable')) {
        reason = 'usage_unavailable';
      } else if (priced.length > 0) {
        reason = 'partial_coverage';
      }
      return {
        status: available ? 'available' : 'unavailable',
        currency: 'USD',
        ...(available
          ? {
              amount: sumAmounts(priced.map((call) => call.amount ?? '0')),
              basis: priced[0].basis,
            }
          : {}),
        coverage,
        reason,
        calls: calls.map((call) => ({ ...call })),
      };
    },
  };
}

/** Combine observed segment provenance without fabricating calls for missing historical accounting. */
export function combineResponseAccounting(
  previous: ResponseAccounting | undefined,
  current: ResponseAccounting | undefined,
): ResponseAccounting {
  const calls = [...(previous?.calls ?? []), ...(current?.calls ?? [])];
  const conflicting =
    previous?.reason === 'conflicting_usage' || current?.reason === 'conflicting_usage';
  const snapshot = createResponseAccountingCollector({
    seed: {
      status: 'unavailable',
      currency: 'USD',
      coverage: 'none',
      reason: conflicting ? 'conflicting_usage' : 'usage_unavailable',
      calls,
    },
  }).snapshot();
  const missing = [previous, current].some(
    (value) => value == null || (value.calls.length === 0 && value.status === 'unavailable'),
  );
  if (!missing || conflicting) return snapshot;
  const priced = calls.some((call) => call.amount != null);
  return {
    status: 'unavailable',
    currency: 'USD',
    coverage: priced ? 'partial' : 'none',
    reason: priced ? 'partial_coverage' : 'usage_unavailable',
    calls: snapshot.calls,
  };
}

/** Persist complete call provenance before the ephemeral generation is removed. */
export function buildCollectedResponseAccounting(
  collectedUsage: ReadonlyArray<UsageMetadata | null | undefined>,
  emittedUsage: ReadonlyArray<TTokenUsageEvent>,
  options: AccountingCollectorOptions = {},
): ResponseAccounting {
  const collector = createResponseAccountingCollector(options);
  for (const entry of collectedUsage) {
    collector.record(entry ?? undefined, {
      __invoked_model: entry?.model,
      __invoked_provider: entry?.provider,
    });
  }
  for (const entry of emittedUsage) {
    if (
      entry.usage_type !== 'activity-label' &&
      entry.usage_type !== 'activity-phase' &&
      entry.usage_type !== 'reasoning-label'
    )
      continue;
    // Label calls can use a distinct endpoint config that the collected parent
    // batch does not retain. Preserve their usage, but never price them with
    // the primary Agent's config or report an incomplete total as complete.
    collector.record(
      entry,
      { __invoked_model: entry.model, __invoked_provider: entry.provider },
      undefined,
      entry.runId && entry.seq != null ? `${entry.runId}:${entry.seq}` : undefined,
    );
  }
  return collector.snapshot();
}

/** Plain metadata patch shared by completion and abort saves after transient jobs are removed. */
export function buildPersistedResponseAccounting(options: {
  collectedUsage?: ReadonlyArray<UsageMetadata | null | undefined>;
  emittedUsage: ReadonlyArray<TTokenUsageEvent>;
  billingEnabled?: boolean;
  billing?: Parameters<typeof createApplicationBillingQuote>[0];
}): { accounting?: ResponseAccounting } {
  if (!options.collectedUsage?.length) return {};
  const quote =
    options.billingEnabled === true && typeof options.billing?.getValueKey === 'function'
      ? createApplicationBillingQuote(options.billing)
      : undefined;
  return {
    accounting: buildCollectedResponseAccounting(options.collectedUsage, options.emittedUsage, {
      quote,
    }),
  };
}

/**
 * Reuse application billing, but reject its unknown-model default-rate fallback.
 * This is an application charge, not a claim about a provider invoice.
 */
export function createApplicationBillingQuote(options: {
  pricing: PricingFns;
  getValueKey: (model: string) => string | undefined;
  resolveEndpointTokenConfig?: (usage: UsageMetadata) => EndpointTokenConfig | undefined;
}): (usage: UsageMetadata) => AccountingQuote | undefined {
  return (usage) => {
    if (!usage.model) {
      return undefined;
    }
    const endpointTokenConfig = options.resolveEndpointTokenConfig?.(usage);
    const configured = endpointTokenConfig?.[usage.model];
    const valueKey = options.getValueKey(usage.model);
    const rates = configured ?? (valueKey ? tokenValues[valueKey] : undefined);
    if (
      !rates ||
      !Number.isFinite(rates.prompt) ||
      rates.prompt < 0 ||
      !Number.isFinite(rates.completion) ||
      rates.completion < 0
    ) {
      return undefined;
    }
    const amount = computeUsageCostUSD(usage, options.pricing, endpointTokenConfig);
    if (!Number.isFinite(amount) || amount < 0 || amount >= 1e15) {
      return undefined;
    }
    return { amount: amount.toFixed(12), basis: 'application_billing' };
  };
}

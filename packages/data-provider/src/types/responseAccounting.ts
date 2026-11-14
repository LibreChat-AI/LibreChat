/** An application-billing amount is not a provider invoice or list-price estimate. */
export type AccountingBasis = 'provider_reported' | 'application_billing';
export type AccountingModelSource =
  | 'provider_reported'
  | 'runtime_reported'
  | 'configured'
  | 'unknown';

export interface ResponseAccountingCall {
  provider?: string;
  model?: string;
  modelSource: AccountingModelSource;
  usageType:
    | 'message'
    | 'summarization'
    | 'subagent'
    | 'sequential'
    | 'activity-label'
    | 'activity-phase'
    | 'reasoning-label';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  amount?: string;
  basis?: AccountingBasis;
  reason: 'priced' | 'pricing_unavailable' | 'usage_unavailable' | 'invalid_usage';
}

/** Separate from token usage: partial costs must never appear as a run's total. */
export interface ResponseAccounting {
  status: 'available' | 'unavailable';
  currency: 'USD';
  amount?: string;
  basis?: AccountingBasis;
  coverage: 'complete' | 'partial' | 'none';
  reason:
    | 'priced'
    | 'pricing_unavailable'
    | 'usage_unavailable'
    | 'partial_coverage'
    | 'mixed_bases'
    | 'conflicting_usage';
  calls: ResponseAccountingCall[];
}

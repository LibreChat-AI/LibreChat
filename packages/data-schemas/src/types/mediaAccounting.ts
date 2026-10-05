import type { MediaOperation } from 'librechat-data-provider';
import type {
  BalancePreparationRequest,
  BalanceReservationResult,
  IBalanceUpdate,
} from './balance';
import type { CreditsTransactionWriter } from './transaction';
import type { IBalanceAppliedSettlement } from './balance';
import type { MediaOwnerScope, MediaPage } from './media';

export type { IBalanceHold, IBalanceAppliedSettlement, IBalancePendingSettlement } from './balance';

export type MediaAccountingPolicy = {
  maxHoldsPerUser: number;
  maxAttempts: number;
  shortfall?: 'debt' | 'absorb';
};
export type MediaAccountingStep =
  | 'registering'
  | 'checked'
  | 'registered'
  | 'admitted'
  | 'pinned'
  | 'held'
  | 'effect'
  | 'allocated'
  | 'assigned'
  | 'applied'
  | 'projected'
  | 'ledger'
  | 'published'
  | 'cleared';
export type MediaAccountingHooks = { afterStep?: (step: MediaAccountingStep) => Promise<void> };
export type MediaAccountingDependencies = MediaAccountingHooks & {
  prepareBalance?: (request: BalancePreparationRequest) => Promise<BalanceReservationResult | null>;
  upsertCreditsTransaction?: CreditsTransactionWriter;
};
export type MediaSettlementEffect = {
  kind: 'charge' | 'release' | 'debt_collection';
  credits: number;
  costUSD?: number;
  costSource?: 'provider' | 'tokens' | 'estimate';
  shortfall?: 'debt' | 'absorb';
  creditsPerUSD?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  operation?: MediaOperation;
};
export type MediaSettlementRecord = MediaOwnerScope & {
  settlementId: string;
  jobId: string;
  balanceId?: string;
  estimatedCredits: number;
  maxCredits: number;
  holdFingerprint: string;
  createdAt: Date;
  reviewAt: Date;
  state: 'initializing' | 'holding' | 'held' | 'ready' | 'applied' | 'published';
  effect?: MediaSettlementEffect;
  effectFingerprint?: string;
  sequence?: number;
  result?: IBalanceAppliedSettlement;
  balanceAcknowledged: boolean;
};
export type MediaHoldResult = {
  status: 'held' | 'insufficient' | 'settled' | 'unavailable' | 'busy';
  settlementId: string;
  availableCredits?: number;
};
export type MediaSettlementResult = {
  status: 'settled' | 'pending';
  settlementId: string;
  result?: IBalanceAppliedSettlement;
};
export type AcquireMediaHoldInput = {
  scope: MediaOwnerScope;
  jobId: string;
  estimatedCredits: number;
  maxCredits: number;
  reviewAt: Date | string;
  now: Date | string;
  policy: MediaAccountingPolicy;
  initialBalance?: IBalanceUpdate;
};
export type SettleMediaJobInput = {
  scope: MediaOwnerScope;
  jobId: string;
  effect: MediaSettlementEffect;
  policy: MediaAccountingPolicy;
};
export type RecordMediaUsageInput = {
  scope: MediaOwnerScope;
  jobId: string;
  credits?: number;
  costUSD?: number;
  costSource?: MediaSettlementEffect['costSource'];
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
};
export interface MediaAccountingMethods {
  ensureMediaAccountingIndexes(): Promise<void>;
  listMediaAccountingScopes(input: {
    limit: number;
    cursor?: string;
  }): Promise<MediaPage<MediaOwnerScope>>;
  hasMediaAccountingObligations(scope: MediaOwnerScope): Promise<boolean>;
  deleteMediaAccountingHistory(scope: MediaOwnerScope): Promise<void>;
  acquireMediaHold(input: AcquireMediaHoldInput): Promise<MediaHoldResult>;
  settleMediaJob(input: SettleMediaJobInput): Promise<MediaSettlementResult>;
  releaseMediaHold(
    input: Omit<SettleMediaJobInput, 'effect'> & { certainNoCharge: true },
  ): Promise<MediaSettlementResult>;
  reconcileMediaAccounting(input: {
    scope: MediaOwnerScope;
    limit: number;
    policy: MediaAccountingPolicy;
  }): Promise<number>;
  recordMediaUsage(input: RecordMediaUsageInput): Promise<void>;
}

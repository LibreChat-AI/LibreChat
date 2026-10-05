import type { RefillIntervalUnit } from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';

export type IBalanceHold = { settlementId: string; jobId: string; amount: number; reviewAt: Date };
export type IBalanceAppliedSettlement = {
  debitedCredits: number;
  debtCredits: number;
  /** Charge above this media job's reservation that could not be paid. */
  overrunDebtCredits?: number;
  /** Unpaid reserved credits already consumed by another balance writer. */
  holdShortfallCredits?: number;
  releasedCredits: number;
  remainingCredits: number;
};
export type IBalancePendingSettlement = {
  settlementId: string;
  sequence: number;
  phase: 'allocated' | 'applied';
  result?: IBalanceAppliedSettlement;
};

/** Whole credits held against a balance while the request that reserved them is in flight */
export interface IBalanceReservation {
  id: string;
  amount: number;
  expiresAt: Date;
}

/** An applied auto-refill whose ledger transaction has not been confirmed as recorded */
export interface IBalancePendingRefill {
  transactionId: Types.ObjectId;
  rawAmount: number;
}

export interface IBalance extends Document {
  user: Types.ObjectId;
  tokenCredits: number;
  // Automatic refill settings
  autoRefillEnabled: boolean;
  refillIntervalValue: number;
  refillIntervalUnit: RefillIntervalUnit;
  lastRefill: Date;
  refillAmount: number;
  tenantId?: string;
  /** Reservation state is excluded from reads unless explicitly selected */
  reservations?: IBalanceReservation[];
  /** Sum of in-flight reservations and durable holds, maintained by their atomic writes. */
  reservedCredits?: number;
  availableCredits?: number;
  mediaHeldCredits?: number;
  pendingRefill?: IBalancePendingRefill;
  mediaGeneration?: string;
  mediaHolds?: IBalanceHold[];
  mediaDebtCredits?: number;
  mediaSettlementSequence?: number;
  mediaPendingSettlement?: IBalancePendingSettlement;
}

/** Plain data fields for creating or updating a balance record (no Mongoose Document methods) */
export interface IBalanceUpdate {
  user?: string;
  tokenCredits?: number;
  autoRefillEnabled?: boolean;
  refillIntervalValue?: number;
  refillIntervalUnit?: RefillIntervalUnit;
  refillAmount?: number;
  lastRefill?: Date;
}

/** Deferred records still have durable media obligations and are left intact. */
export type BalanceDeletionResult = {
  acknowledged: boolean;
  deletedCount: number;
  deferredCount: number;
};

/** Holds credits against a user's balance for the lifetime of one in-flight request */
export interface BalanceReservationRequest {
  user: string;
  /** Unique per request; the release addresses the reservation by this id */
  reservationId: string;
  /** Credits the request is admitted against */
  amount: number;
  /** An unreleased reservation stops counting against the balance at this instant */
  expiresAt: Date;
  /** Creates the balance record with these fields when the user has none */
  initialBalance?: IBalanceUpdate;
}

/** Maintains the shared balance before another durable admission mechanism holds credits. */
export type BalancePreparationRequest = Pick<
  BalanceReservationRequest,
  'user' | 'amount' | 'initialBalance'
> & {
  /** Explicit tenant scope for background work, including the legacy null tenant. */
  tenantId?: string | null;
  /** Keeps recovery tied to the balance originally selected for the request. */
  balanceId?: string;
};

export interface BalanceReservationRenewal {
  user: string;
  reservationId: string;
  expiresAt: Date;
}

export interface BalanceReservationRelease {
  user: string;
  reservationId: string;
  /** The amount that was reserved */
  amount: number;
}

export interface BalanceReservationResult {
  reserved: boolean;
  /** Credits not held by other in-flight requests, after any auto-refill */
  balance: number;
}

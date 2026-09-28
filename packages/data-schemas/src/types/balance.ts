import type { RefillIntervalUnit } from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';

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
  /** Sum of `reservations` amounts, maintained by the same writes */
  reservedCredits?: number;
  pendingRefill?: IBalancePendingRefill;
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

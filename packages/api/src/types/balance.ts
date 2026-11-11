import type { BalanceRefillMode, RefillIntervalUnit } from 'librechat-data-provider';

export interface BalanceUpdateFields {
  user?: string;
  tokenCredits?: number;
  autoRefillEnabled?: boolean;
  refillIntervalValue?: number;
  refillIntervalUnit?: RefillIntervalUnit;
  refillAmount?: number;
  refillMode?: BalanceRefillMode;
  lastRefill?: Date;
  /** Written only together with `tokenCredits`: the credits that grant starts the period with */
  allotment?: number;
  allottedAt?: Date;
}

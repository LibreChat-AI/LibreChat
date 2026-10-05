import type { TBalanceResponse } from 'librechat-data-provider';

/** The reservation total includes debt; only actual holds belong in the held breakdown. */
export function getBalanceAmounts(balance: Partial<TBalanceResponse>) {
  const reserved = balance.reservedCredits ?? 0;
  const owed = balance.mediaDebtCredits ?? 0;
  return {
    available: balance.availableCredits ?? Math.max(0, (balance.tokenCredits ?? 0) - reserved),
    held: Math.max(0, reserved - owed),
    owed,
  };
}

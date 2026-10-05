import { useMemo } from 'react';
import type { TBalanceResponse } from 'librechat-data-provider';
import type { BalanceSummary, CurrencyConfig } from '~/utils';
import { useGetStartupConfig, useGetUserBalance } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import { summarizeBalance } from '~/utils';

export type BalanceState =
  | { status: 'loading' }
  | { status: 'error' }
  /** Balance is on in the startup config but the server sent no record for this user */
  | { status: 'empty' }
  | { status: 'success'; summary: BalanceSummary };

export interface BalanceView {
  enabled: boolean;
  state: BalanceState;
  currency?: CurrencyConfig;
  /** The raw record, for detail rows the summary does not carry */
  balance?: TBalanceResponse;
}

/**
 * The user's balance as every surface presents it. A stale reading wins over a
 * failed refetch, so a transient error never blanks a figure the user already saw.
 */
export default function useBalanceSummary(): BalanceView {
  const { isAuthenticated } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();
  const config = startupConfig?.balance;
  const enabled = config?.enabled === true;
  const query = useGetUserBalance({ enabled: isAuthenticated === true && enabled });
  const { data, isError } = query;
  const display = config?.display;
  const startBalance = config?.startBalance;

  const state = useMemo<BalanceState>(() => {
    if (data != null && typeof data.tokenCredits === 'number') {
      return { status: 'success', summary: summarizeBalance(data, { display, startBalance }) };
    }
    if (isError) {
      return { status: 'error' };
    }
    return query.isFetched ? { status: 'empty' } : { status: 'loading' };
  }, [data, isError, query.isFetched, display, startBalance]);

  return {
    enabled,
    state,
    currency: startupConfig?.interface?.currency,
    balance: state.status === 'success' ? data : undefined,
  };
}

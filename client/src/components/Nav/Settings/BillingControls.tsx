import type { TBalanceResponse } from 'librechat-data-provider';
import RequestCreditsButton from '../SettingsTabs/Balance/RequestCreditsButton';
import AutoRefillSettings from '../SettingsTabs/Balance/AutoRefillSettings';
import { useGetStartupConfig, useGetUserBalance } from '~/data-provider';
import TokenCreditsItem from '../SettingsTabs/Balance/TokenCreditsItem';
import { useAuthContext, useLocalize } from '~/hooks';

function useBalance(): Partial<TBalanceResponse> {
  const { isAuthenticated } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();

  const balanceQuery = useGetUserBalance({
    enabled: !!isAuthenticated && !!startupConfig?.balance?.enabled,
  });

  return balanceQuery.data ?? {};
}

export function TokenCredits() {
  const { tokenCredits = 0 } = useBalance();
  return (
    <div className="flex items-center justify-between gap-2">
      <TokenCreditsItem tokenCredits={tokenCredits} />
      <RequestCreditsButton />
    </div>
  );
}

export function AutoRefill() {
  const localize = useLocalize();
  const {
    autoRefillEnabled = false,
    lastRefill,
    refillAmount,
    refillIntervalUnit,
    refillIntervalValue,
  } = useBalance();

  const hasValidRefillSettings =
    lastRefill !== undefined &&
    refillAmount !== undefined &&
    refillIntervalUnit !== undefined &&
    refillIntervalValue !== undefined;

  if (!autoRefillEnabled) {
    return (
      <div className="text-text-secondary text-sm">
        {localize('com_nav_balance_auto_refill_disabled')}
      </div>
    );
  }

  if (!hasValidRefillSettings) {
    return (
      <div className="text-text-destructive text-sm">
        {localize('com_nav_balance_auto_refill_error')}
      </div>
    );
  }

  return (
    <AutoRefillSettings
      lastRefill={lastRefill}
      refillAmount={refillAmount}
      refillIntervalUnit={refillIntervalUnit}
      refillIntervalValue={refillIntervalValue}
    />
  );
}

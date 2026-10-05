import AutoRefillSettings from '../SettingsTabs/Balance/AutoRefillSettings';
import useBalanceSummary from '~/hooks/useBalanceSummary';
import { formatBalanceAmount } from '~/utils';
import Balance from '~/components/Balance';
import { useLocalize } from '~/hooks';

/** The same reading the context gauge shows, so both surfaces agree. */
export function TokenCredits() {
  return <Balance />;
}

export function AutoRefill() {
  const localize = useLocalize();
  const { state, currency, balance } = useBalanceSummary();

  if (state.status !== 'success' || balance == null) {
    return null;
  }

  const { summary } = state;
  const { lastRefill, refillIntervalUnit, refillIntervalValue } = balance;

  if (!balance.autoRefillEnabled) {
    return (
      <div className="text-text-secondary text-sm">
        {localize('com_nav_balance_auto_refill_disabled')}
      </div>
    );
  }

  if (
    lastRefill === undefined ||
    summary.refillAmount == null ||
    refillIntervalUnit === undefined ||
    refillIntervalValue === undefined
  ) {
    return (
      <div className="text-text-destructive text-sm">
        {localize('com_nav_balance_auto_refill_error')}
      </div>
    );
  }

  return (
    <AutoRefillSettings
      lastRefill={lastRefill}
      nextRefill={summary.nextRefill}
      /** Percent-only deployments show no credit figures anywhere */
      refillAmount={
        summary.display === 'percent'
          ? null
          : formatBalanceAmount(summary.refillAmount, summary.display, currency)
      }
      refillIntervalUnit={refillIntervalUnit}
      refillIntervalValue={refillIntervalValue}
    />
  );
}

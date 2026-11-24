import { BALANCE_DISPLAY_MODES } from 'librechat-data-provider';
import type { BalanceDisplay } from 'librechat-data-provider';
import type { CurrencyConfig } from '~/utils';
import { useGetStartupConfig } from '~/data-provider';

/** Admin config overrides persist without schema validation, so an unknown mode can arrive. */
export const toDisplay = (value: unknown): BalanceDisplay =>
  BALANCE_DISPLAY_MODES.find((mode) => mode === value) ?? 'credits';

/**
 * How the deployment shows balance figures, for surfaces that only format an amount. Its own
 * module so the message parts host can read it at boot without loading the balance summary.
 */
export default function useBalanceDisplay(): {
  display: BalanceDisplay;
  currency?: CurrencyConfig;
} {
  const { data: startupConfig } = useGetStartupConfig();
  return {
    display: toDisplay(startupConfig?.balance?.display),
    currency: startupConfig?.interface?.currency,
  };
}

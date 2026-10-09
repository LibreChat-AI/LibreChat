import { memo, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Progress, Skeleton } from '@librechat/client';
import type { BalanceSummary, BalanceTone, CurrencyConfig } from '~/utils';
import type { BalanceState } from '~/hooks/useBalanceSummary';
import { formatBalanceAmount, formatTimeUntil } from '~/utils/balance';
import useTimeTick from '~/hooks/useTimeTick';
import useLocalize from '~/hooks/useLocalize';
import cn from '~/utils/cn';

const TONE_VARIANT = {
  normal: 'default',
  warning: 'warning',
  danger: 'error',
} as const satisfies Record<BalanceTone, 'default' | 'warning' | 'error'>;

const TONE_TEXT: Record<BalanceTone, string> = {
  normal: 'text-text-secondary',
  warning: 'text-text-warning',
  danger: 'text-text-destructive',
};

interface SummaryProps {
  state: BalanceState;
  currency?: CurrencyConfig;
  className?: string;
}

function useRefillText(summary: BalanceSummary, currency?: CurrencyConfig): string {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  /** Re-render once a minute so "in 5 minutes" counts down while the view stays open */
  useTimeTick();

  const { display, refillAmount, refillMode, nextRefill } = summary;
  if (refillAmount == null) {
    return localize('com_ui_balance_no_refill');
  }
  const when =
    nextRefill != null ? formatTimeUntil(nextRefill, Date.now(), i18n.resolvedLanguage) : null;
  if (refillMode === 'reset') {
    if (display === 'percent') {
      return when != null
        ? localize('com_ui_balance_reset_in', { 0: when })
        : localize('com_ui_balance_reset_due');
    }
    const amount = formatBalanceAmount(refillAmount, display, currency);
    return when != null
      ? localize('com_ui_balance_reset_amount_in', { 0: amount, 1: when })
      : localize('com_ui_balance_reset_amount_due', { 0: amount });
  }
  if (display === 'percent') {
    return when != null
      ? localize('com_ui_balance_refill_in', { 0: when })
      : localize('com_ui_balance_refill_when_empty');
  }
  const amount = formatBalanceAmount(refillAmount, display, currency);
  return when != null
    ? localize('com_ui_balance_refill_amount_in', { 0: amount, 1: when })
    : localize('com_ui_balance_refill_amount_when_empty', { 0: amount });
}

function Reading({ summary, currency }: { summary: BalanceSummary; currency?: CurrencyConfig }) {
  const localize = useLocalize();
  const refillText = useRefillText(summary, currency);
  const { display, credits, usedPercent, tone } = summary;

  let value: string;
  if (display === 'percent') {
    value =
      usedPercent != null
        ? localize('com_ui_balance_used', { 0: String(usedPercent) })
        : localize('com_ui_balance_usage_unavailable');
  } else if (display === 'currency') {
    value = formatBalanceAmount(credits, display, currency);
  } else {
    value = localize('com_ui_balance_credits', {
      0: formatBalanceAmount(credits, display, currency),
    });
  }

  let status: string | null = null;
  if (tone === 'danger') {
    status = localize('com_ui_balance_empty');
  } else if (display !== 'percent' && usedPercent != null) {
    status = localize('com_ui_balance_used', { 0: String(usedPercent) });
  }

  return (
    <>
      <span
        className={cn('justify-self-end text-xs font-medium whitespace-nowrap', TONE_TEXT[tone])}
        data-testid="balance-value"
      >
        {value}
      </span>
      {usedPercent != null && (
        <Progress
          value={usedPercent}
          aria-label={localize('com_ui_balance_used_label')}
          className="col-span-2"
          variant={TONE_VARIANT[tone]}
        />
      )}
      <span className="text-text-secondary min-w-0 text-xs" data-testid="balance-refill">
        {refillText}
      </span>
      {status != null && (
        <span
          className={cn('justify-self-end text-xs whitespace-nowrap', TONE_TEXT[tone])}
          data-testid="balance-status"
        >
          {status}
        </span>
      )}
    </>
  );
}

/**
 * The balance reading shared by the context gauge popover and the settings dialog:
 * a title with the figure the deployment chose to show, the share of the allotment
 * spent, and when the next refill lands.
 */
function Summary({ state, currency, className }: SummaryProps) {
  const localize = useLocalize();
  const headingId = useId();

  if (state.status === 'empty') {
    return null;
  }

  const percentOnly = state.status === 'success' && state.summary.display === 'percent';
  return (
    <section
      aria-labelledby={headingId}
      aria-busy={state.status === 'loading'}
      data-testid="balance-summary"
      className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2', className)}
    >
      <h3 id={headingId} className="text-text-primary text-sm font-medium">
        {localize(percentOnly ? 'com_ui_balance_usage_limit' : 'com_nav_balance')}
      </h3>
      {state.status === 'loading' && (
        <>
          <Skeleton className="h-3 w-16" />
          <Skeleton className="col-span-2 h-2 w-full rounded-full" />
        </>
      )}
      {state.status === 'error' && (
        <>
          <span />
          <p className="text-text-destructive col-span-2 text-xs" role="alert">
            {localize('com_ui_balance_error')}
          </p>
        </>
      )}
      {state.status === 'success' && <Reading summary={state.summary} currency={currency} />}
    </section>
  );
}

export default memo(Summary);

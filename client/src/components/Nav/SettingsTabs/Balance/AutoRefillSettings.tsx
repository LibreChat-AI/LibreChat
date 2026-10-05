import React from 'react';
import { Label, InfoHoverCard, ESide } from '@librechat/client';

import type { RefillIntervalUnit, TBalanceResponse } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

import { useLocalize, useClockFormat } from '~/hooks';

function ensureExhaustive(value: never): void {
  void value;
}

interface AutoRefillSettingsProps {
  lastRefill: NonNullable<TBalanceResponse['lastRefill']>;
  /** When the next refill becomes eligible — the same date the balance summary counts down to */
  nextRefill: Date | null;
  /** Formatted in the deployment's display mode; null hides the row (percent-only) */
  refillAmount: string | null;
  refillIntervalUnit: RefillIntervalUnit;
  refillIntervalValue: number;
}

const AutoRefillSettings: React.FC<AutoRefillSettingsProps> = ({
  lastRefill,
  nextRefill,
  refillAmount,
  refillIntervalUnit,
  refillIntervalValue,
}) => {
  const localize = useLocalize();
  const hour12 = useClockFormat();

  const lastRefillDate = lastRefill ? new Date(lastRefill) : null;

  const getLocalizedIntervalUnit = (value: number, unit: RefillIntervalUnit): string => {
    let key: TranslationKeys;
    switch (unit) {
      case 'seconds':
        key = value === 1 ? 'com_nav_balance_second' : 'com_nav_balance_seconds';
        break;
      case 'minutes':
        key = value === 1 ? 'com_nav_balance_minute' : 'com_nav_balance_minutes';
        break;
      case 'hours':
        key = value === 1 ? 'com_nav_balance_hour' : 'com_nav_balance_hours';
        break;
      case 'days':
        key = value === 1 ? 'com_nav_balance_day' : 'com_nav_balance_days';
        break;
      case 'weeks':
        key = value === 1 ? 'com_nav_balance_week' : 'com_nav_balance_weeks';
        break;
      case 'months':
        key = value === 1 ? 'com_nav_balance_month' : 'com_nav_balance_months';
        break;
      default: {
        ensureExhaustive(unit);
        key = 'com_nav_balance_seconds';
      }
    }
    return localize(key);
  };

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-medium">{localize('com_nav_balance_auto_refill_settings')}</h3>
      <div className="mb-1 flex justify-between text-sm">
        <span>{localize('com_nav_balance_last_refill')}</span>
        <span>{lastRefillDate ? lastRefillDate.toLocaleString(undefined, { hour12 }) : '-'}</span>
      </div>
      {refillAmount != null && (
        <div className="mb-1 flex justify-between text-sm">
          <span>{localize('com_nav_balance_refill_amount')}</span>
          <span>{refillAmount}</span>
        </div>
      )}
      <div className="mb-1 flex justify-between text-sm">
        <span>{localize('com_nav_balance_interval')}</span>
        <span>
          {localize('com_nav_balance_every')} {refillIntervalValue}{' '}
          {getLocalizedIntervalUnit(refillIntervalValue, refillIntervalUnit)}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Label className="font-light">{localize('com_nav_balance_next_refill')}</Label>
          <InfoHoverCard side={ESide.Bottom} text={localize('com_nav_balance_next_refill_info')} />
        </div>

        <span className="text-text-primary text-sm font-medium" role="note">
          {nextRefill ? nextRefill.toLocaleString(undefined, { hour12 }) : '-'}
        </span>
      </div>
    </div>
  );
};

export default AutoRefillSettings;

import React from 'react';
import { Label, InfoHoverCard, ESide } from '@librechat/client';
import { getBalanceAmounts } from '~/utils/balance';
import { useLocalize } from '~/hooks';

interface TokenCreditsItemProps {
  tokenCredits?: number;
  reservedCredits?: number;
  mediaDebtCredits?: number;
  availableCredits?: number;
}

const TokenCreditsItem: React.FC<TokenCreditsItemProps> = ({
  tokenCredits = 0,
  reservedCredits = 0,
  mediaDebtCredits = 0,
  availableCredits,
}) => {
  const localize = useLocalize();
  const balance = getBalanceAmounts({
    tokenCredits,
    reservedCredits,
    mediaDebtCredits,
    availableCredits,
  });
  const amounts = [
    ['com_nav_balance_available', balance.available],
    ['com_nav_balance_held', balance.held],
    ['com_nav_balance_owed', balance.owed],
  ] as const;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        {/* Left Section: Label */}
        <div className="flex items-center space-x-2">
          <Label className="font-light">{localize('com_nav_balance')}</Label>
          <InfoHoverCard side={ESide.Bottom} text={localize('com_nav_info_balance')} />
        </div>

        {/* Right Section: tokenCredits Value */}
        <span className="text-text-primary text-sm font-medium" role="note">
          {tokenCredits !== undefined ? tokenCredits.toFixed(2) : '0.00'}
        </span>
      </div>
      <dl className="space-y-2 text-sm">
        {amounts.map(([key, value]) => (
          <div key={key} className="flex items-center justify-between gap-3">
            <dt className="text-text-secondary">{localize(key)}</dt>
            <dd className="text-text-primary tabular-nums">{value.toFixed(2)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
};

export default TokenCreditsItem;

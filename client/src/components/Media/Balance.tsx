import { useTranslation } from 'react-i18next';
import { getBalanceAmounts } from '~/utils/balance';
import { useLocalize } from '~/hooks';
import { useMediaHost } from './host';

export function MediaBalanceExplanation() {
  const { balance } = useMediaHost();
  const localize = useLocalize();
  const { i18n } = useTranslation();
  if (!balance) return null;
  const amounts = getBalanceAmounts(balance);
  const number = new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language);
  return (
    <p>
      {localize('com_media_balance_limit', {
        available: number.format(amounts.available),
        held: number.format(amounts.held),
        owed: number.format(amounts.owed),
      })}
    </p>
  );
}

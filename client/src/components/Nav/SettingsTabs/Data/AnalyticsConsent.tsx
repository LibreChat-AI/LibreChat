import { useId } from 'react';
import { useAtom } from 'jotai';
import { Switch } from '@librechat/client';
import { analyticsConsentAtom } from '~/store/analytics';
import { useLocalize } from '~/hooks';

/** Changes the answer given to the analytics consent banner. Shown only when the
 *  deployment configured Google Tag Manager. Loading happens in `useAnalytics`;
 *  turning it off cannot unload a container already on the page, which the
 *  description tells the reader a reload completes. */
export default function AnalyticsConsentToggle() {
  const localize = useLocalize();
  const id = useId();
  const [consent, setConsent] = useAtom(analyticsConsentAtom);
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;

  return (
    <div className="flex items-center justify-between">
      <div>
        <div id={labelId}>{localize('com_ui_analytics_consent_setting')}</div>
        <div id={descriptionId} className="text-text-secondary mt-1 text-xs">
          {localize('com_ui_analytics_consent_setting_description')}
        </div>
      </div>
      <Switch
        checked={consent === 'granted'}
        onCheckedChange={(checked: boolean) => setConsent(checked ? 'granted' : 'denied')}
        className="ms-4"
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        data-testid="analytics-consent-switch"
      />
    </div>
  );
}

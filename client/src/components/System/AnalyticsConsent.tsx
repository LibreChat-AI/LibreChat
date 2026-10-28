import { useId } from 'react';
import { Button } from '@librechat/client';
import useAnalytics from '~/hooks/Config/useAnalytics';
import { useLocalize } from '~/hooks';

type AnalyticsConsentProps = {
  /** The deployment's `ANALYTICS_GTM_ID`, from the startup config of the page shell. */
  gtmId?: string | null;
};

/**
 * Loads Google Tag Manager once the viewer consents, and asks for that consent
 * when it has not been given or refused yet. The prompt is a non-modal region at
 * the bottom of the viewport: it does not take focus or block the page, and
 * either answer hides it. The choice can be changed later in Settings.
 */
export default function AnalyticsConsent({ gtmId }: AnalyticsConsentProps) {
  const { enabled, consent, setConsent } = useAnalytics(gtmId);

  if (!enabled || consent != null) {
    return null;
  }

  return (
    <ConsentBanner onAccept={() => setConsent('granted')} onDecline={() => setConsent('denied')} />
  );
}

function ConsentBanner({ onAccept, onDecline }: { onAccept: () => void; onDecline: () => void }) {
  const localize = useLocalize();
  const id = useId();
  const messageId = `${id}-message`;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-4">
      <section
        aria-label={localize('com_ui_analytics_consent_label')}
        aria-describedby={messageId}
        className="border-border-light bg-surface-dialog text-text-primary pointer-events-auto flex w-full max-w-xl flex-col gap-3 rounded-2xl border p-4 shadow-lg sm:flex-row sm:items-center"
      >
        <p id={messageId} className="text-text-secondary flex-1 text-sm">
          {localize('com_ui_analytics_consent_message')}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="outline" onClick={onDecline}>
            {localize('com_ui_analytics_consent_decline')}
          </Button>
          <Button type="button" variant="outline" onClick={onAccept}>
            {localize('com_ui_analytics_consent_accept')}
          </Button>
        </div>
      </section>
    </div>
  );
}

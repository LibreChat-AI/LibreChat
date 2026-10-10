import { Trans } from 'react-i18next';
import type { TStartupConfig } from 'librechat-data-provider';
import { hasPublishedPolicies, policyUrls } from '~/utils/policies';
import { useLocalize } from '~/hooks';

/** The links sit inside a sentence, so they keep an underline of their own:
 *  colour alone would be the only thing telling them apart from the text
 *  around them. No `target`, like the rest of the auth screens. */
const linkClassName =
  'font-medium text-accent-primary underline underline-offset-2 transition-colors hover:text-accent-primary-hover focus-visible:text-accent-primary-hover';

/** Worded for whichever policies the deployment published, so one it never
 *  wrote is never claimed to have been agreed to. */
const consentKey = (privacyPolicyUrl?: string, termsOfServiceUrl?: string) => {
  if (termsOfServiceUrl == null) {
    return 'com_auth_legal_consent_privacy';
  }
  if (privacyPolicyUrl == null) {
    return 'com_auth_legal_consent_terms';
  }
  return 'com_auth_legal_consent';
};

/**
 * The consent an account is created under, stated where it is created rather
 * than left to a link beneath the composer. It closes the auth card, so it
 * covers the registration form and the provider buttons alike: a first sign-in
 * through a provider creates an account too. Absent entirely on a deployment
 * that published neither policy.
 */
function LegalConsent({ startupConfig }: { startupConfig: TStartupConfig | null | undefined }) {
  const localize = useLocalize();
  const { privacyPolicyUrl, termsOfServiceUrl } = policyUrls(startupConfig);

  /** The same answer the layout uses to drop its footer bar, so the two cannot
   *  both be on the screen: it is false with nothing published, and on a
   *  deployment that collects an explicit acceptance of its own. */
  if (!hasPublishedPolicies(startupConfig)) {
    return null;
  }

  return (
    <p className="text-text-secondary mt-4 text-center text-sm font-light">
      <Trans
        i18nKey={consentKey(privacyPolicyUrl, termsOfServiceUrl)}
        components={{
          privacy: (
            <a className={linkClassName} href={privacyPolicyUrl} rel="noreferrer">
              {localize('com_ui_privacy_policy')}
            </a>
          ),
          terms: (
            <a className={linkClassName} href={termsOfServiceUrl} rel="noreferrer">
              {localize('com_ui_terms_of_service')}
            </a>
          ),
        }}
      />
    </p>
  );
}

export default LegalConsent;

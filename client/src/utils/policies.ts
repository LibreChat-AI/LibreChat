import type { TStartupConfig } from 'librechat-data-provider';

/**
 * The policy links a deployment published, as the surfaces that render them
 * agree to read it. `externalUrl` is an optional string, so an operator can
 * leave it blank; a blank one is not a published policy, because rendered as a
 * link it points back at the page the reader is on and names a document that
 * does not exist.
 */
export function publishedPolicyUrl(externalUrl?: string): string | undefined {
  const url = externalUrl?.trim();
  return url != null && url !== '' ? url : undefined;
}

type PolicySource = {
  interface?: Pick<NonNullable<TStartupConfig['interface']>, 'privacyPolicy' | 'termsOfService'>;
};

export function policyUrls(startupConfig: PolicySource | null | undefined) {
  return {
    privacyPolicyUrl: publishedPolicyUrl(startupConfig?.interface?.privacyPolicy?.externalUrl),
    termsOfServiceUrl: publishedPolicyUrl(startupConfig?.interface?.termsOfService?.externalUrl),
  };
}

/** Whether the deployment published anything to consent to by continuing. The
 *  auth layout reads this to choose between the consent and its footer bar, so
 *  the two cannot disagree about whether the sentence is on the screen.
 *
 *  A deployment that asks for the terms to be accepted in a modal has its own
 *  explicit acceptance after sign-in (`routes/Root.tsx`), so a sentence saying
 *  the reader already agreed by continuing would contradict the dialog it is
 *  about to show; those screens keep the bare links they always had. */
export function hasPublishedPolicies(startupConfig: PolicySource | null | undefined): boolean {
  if (startupConfig?.interface?.termsOfService?.modalAcceptance === true) {
    return false;
  }
  const { privacyPolicyUrl, termsOfServiceUrl } = policyUrls(startupConfig);
  return privacyPolicyUrl != null || termsOfServiceUrl != null;
}

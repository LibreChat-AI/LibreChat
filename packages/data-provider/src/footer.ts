import type { TStartupConfig } from './config';

/**
 * The startup-config fields that put a footer bar beneath a conversation's
 * composer. Narrow on purpose: the server answers the same question while it
 * serves the HTML shell, reading these fields off its own configuration instead
 * of assembling a startup payload it has no request for.
 */
export type TConfiguredFooterSource = Pick<Partial<TStartupConfig>, 'customFooter'> & {
  interface?: Pick<
    NonNullable<TStartupConfig['interface']>,
    'privacyPolicy' | 'termsOfService'
  > | null;
};

/**
 * Whether a deployment configured footer content of its own — a custom footer,
 * a privacy policy or terms of service.
 *
 * The footer bar is absolutely positioned in a zero-height wrapper, so the
 * composer above it is what reserves its band: this answer decides both the
 * bar and the clearance. The client and the server share it because the two
 * answering differently is exactly the layout correction it exists to remove.
 */
export function hasConfiguredFooter(source?: TConfiguredFooterSource | null): boolean {
  return (
    typeof source?.customFooter === 'string' ||
    source?.interface?.privacyPolicy?.externalUrl != null ||
    source?.interface?.termsOfService?.externalUrl != null
  );
}

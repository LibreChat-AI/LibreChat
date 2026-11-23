import type { TStartupConfig } from './config';

/**
 * The startup-config field that puts a footer bar beneath a conversation's
 * composer. Narrow on purpose: the server answers the same question while it
 * serves the HTML shell, reading this field off its own configuration instead
 * of assembling a startup payload it has no request for.
 */
export type TConfiguredFooterSource = Pick<Partial<TStartupConfig>, 'customFooter'>;

/**
 * Whether a deployment configured footer content of its own.
 *
 * Only a custom footer with content counts. A privacy policy and terms of
 * service are read where they are agreed to, on the auth screens, and on the
 * welcome screen the conversation starts from; a started conversation carries
 * neither, so neither one puts a bar beneath its composer. A footer of
 * nothing, or of whitespace the bar trims away, is an operator suppressing the
 * default disclaimer on the welcome screen; it renders nothing in a
 * conversation, so it is no bar either.
 *
 * The footer bar is absolutely positioned in a zero-height wrapper, so the
 * composer above it is what reserves its band: this answer decides both the
 * bar and the clearance, and it has to match what the bar renders or the
 * composer reserves a band for nothing. The client and the server share it
 * because the two answering differently is exactly the layout correction it
 * exists to remove.
 */
export function hasConfiguredFooter(source?: TConfiguredFooterSource | null): boolean {
  return typeof source?.customFooter === 'string' && source.customFooter.trim() !== '';
}

import { hasConfiguredFooter } from 'librechat-data-provider';
import type { TInterfaceConfig } from 'librechat-data-provider';
import { injectBootstrapConfig } from './bootstrap';

const CONFIGURED_FOOTER_SENTINEL = 'data-librechat-configured-footer="true"';

/** What the deployment configured, as the server holds it: the footer env var
 *  and the interface config the app loaded. */
export interface ConfiguredFooterSource {
  customFooter?: string | null;
  interfaceConfig?: Pick<TInterfaceConfig, 'privacyPolicy' | 'termsOfService'> | null;
}

/**
 * Emits the deployment's footer answer with the HTML shell.
 *
 * A conversation's composer lays out against whether a footer bar sits beneath
 * it, and `/api/config` answers that only after the composer has painted. The
 * server already knows when it serves the document, so it says so and no client
 * has to guess: a first-ever visit to a configured deployment paints the
 * composer in its final position instead of correcting by the bar's height.
 * The answer is the deployment's own configuration — `librechat.yaml` plus
 * `CUSTOM_FOOTER` — because the document is served before there is a caller to
 * resolve: a per-tenant, role or user config override of `privacyPolicy` or
 * `termsOfService` is resolved by `/api/config`, and the client prefers that
 * resolved answer over this one. Reading the effective config here would cost
 * an override query on the document that carries the conversation's LCP, and
 * still could not resolve role or user overrides pre-authentication.
 *
 * Always injected, including the negative answer, so an absent flag means "no
 * server said" (the Vite dev server) rather than "no footer".
 */
export const injectConfiguredFooterBootstrap = (
  html: string,
  source?: ConfiguredFooterSource | null,
): string =>
  injectBootstrapConfig(html, {
    sentinel: CONFIGURED_FOOTER_SENTINEL,
    values: {
      hasConfiguredFooter: hasConfiguredFooter({
        customFooter: source?.customFooter ?? undefined,
        interface: source?.interfaceConfig ?? null,
      }),
    },
  });

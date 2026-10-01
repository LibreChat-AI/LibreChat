import { hasConfiguredFooter } from 'librechat-data-provider';
import { injectBootstrapConfig } from './bootstrap';

const CONFIGURED_FOOTER_SENTINEL = 'data-librechat-configured-footer="true"';

/** What the deployment configured, as the server holds it: the footer env var. */
export interface ConfiguredFooterSource {
  customFooter?: string | null;
}

/**
 * Emits the deployment's footer answer with the HTML shell.
 *
 * A conversation's composer lays out against whether a footer bar sits beneath
 * it, and `/api/config` answers that only after the composer has painted. The
 * server already knows when it serves the document, so it says so and no client
 * has to guess: a first-ever visit to a configured deployment paints the
 * composer in its final position instead of correcting by the bar's height.
 * The answer is the deployment's own `CUSTOM_FOOTER`, because the document is
 * served before there is a caller whose config overrides could be resolved; the
 * client prefers `/api/config`'s resolved answer once it has it.
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
      }),
    },
  });

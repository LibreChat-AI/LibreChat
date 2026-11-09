/** Marks the shell for the boot script in `client/index.html`, which reads `?theme=`. */
export const COLOR_MODE_FROM_URL_ATTRIBUTE = 'data-color-mode-from-url';

/**
 * Opts the HTML shell into the colour-mode handoff (`interface.colorModeFromUrl`).
 *
 * The boot script paints the colour mode before any app script or bootstrap
 * global exists, so the answer rides on the `<html>` element it already reads.
 * Like the footer answer, it is the deployment's base configuration: the shell
 * is served before there is a caller whose overrides could be resolved.
 */
export const injectColorModeHandoff = (html: string, enabled?: boolean | null): string => {
  if (enabled !== true) {
    return html;
  }

  /* Only the tag is inspected: the boot script names the attribute it reads. */
  return html.replace(/<html\b[^>]*>/i, (tag) =>
    tag.includes(COLOR_MODE_FROM_URL_ATTRIBUTE)
      ? tag
      : `<html ${COLOR_MODE_FROM_URL_ATTRIBUTE}${tag.slice('<html'.length)}`,
  );
};

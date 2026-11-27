import { highContrastDarkTheme, highContrastLightTheme } from '@librechat/client';
import type { IThemeRGB } from '@librechat/client';

/**
 * Re-declares the backend document's palette tokens for the selected contrast
 * mode. The document is generated server-side, so its theme cannot know the
 * viewer's explicit appearance choice.
 */
export function withOfficeContrast(html: string, isDarkMode: boolean): string {
  if (!html) {
    return html;
  }

  const palette = isDarkMode ? highContrastDarkTheme : highContrastLightTheme;
  const hex = (token: keyof IThemeRGB, fallback: string): string => {
    const channels = palette[token]?.trim().split(/\s+/).map(Number);
    if (channels?.length !== 3 || channels.some(Number.isNaN)) {
      return fallback;
    }
    return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  };

  const canvas = hex('rgb-surface-primary', isDarkMode ? '#000000' : '#ffffff');
  /** Every ink token collapses to one pure ink in these palettes, so `--muted`
   *  has no softer colour available to it and takes the same value as `--fg`. */
  const ink = hex('rgb-text-primary', isDarkMode ? '#ffffff' : '#000000');
  const border = hex('rgb-border-medium', ink);
  /** Three separable steps off the canvas, so zebra striping, row hover and the
   *  header keep telling each other apart. Each still carries ink at AAA, and
   *  the header and active sheet tab additionally get the ink `--border` the
   *  backend already draws around them, which is what marks them at 3:1. */
  const subtle = hex('rgb-surface-active', canvas);
  const hover = hex('rgb-surface-hover', canvas);
  const raised = hex('rgb-surface-hover-alt', hover);
  const link = hex('rgb-link', isDarkMode ? '#8cc8ff' : '#0000cc');
  const scheme = isDarkMode ? 'dark' : 'light';
  const contrastCSS = `
:root {
  color-scheme: ${scheme};
  --bg: ${canvas};
  --fg: ${ink};
  --muted: ${ink};
  --border: ${border};
  --row-alt: ${subtle};
  --row-hover: ${hover};
  --header-bg: ${raised};
  --tab-active-bg: ${raised};
  --tab-bg: ${canvas};
  --link: ${link};
}
/** WCAG 1.4.1: a link in running text must not be colour alone. */
a { text-decoration: underline; }
`;
  const style = `<style>${contrastCSS}</style>`;
  const headClose = html.toLowerCase().indexOf('</head>');

  // Keep this block last in <head> so it wins the backend stylesheet's equal-specificity media query.
  if (headClose >= 0) {
    return `${html.slice(0, headClose)}${style}${html.slice(headClose)}`;
  }

  // Malformed/partial previews may omit <head>; prepend because there is no head boundary to insert before.
  return `${style}${html}`;
}

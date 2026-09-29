import { IThemeRGB } from '../types';

/**
 * High contrast accessibility themes.
 *
 * Selected through the appearance modes `high-contrast-light` and
 * `high-contrast-dark`, and by `system` when the OS reports
 * `prefers-contrast: more`. They resolve as a built-in `ThemeDefinition`
 * (`highContrastTheme`) that outranks a deployment's custom theme, because a
 * contrast choice is an accessibility need rather than a branding preference.
 *
 * Both maps are complete rather than partial overrides: a token left to fall
 * back to `defaultTheme`/`darkTheme` would silently reintroduce a mid-grey the
 * mode exists to eliminate.
 *
 * Contrast contract, enforced by `highContrast.spec.ts`:
 * - text clears WCAG AAA (7:1) on every surface it can render on, including the
 *   hover and active fills;
 * - solid fills (`surface-submit`, `surface-destructive`, `status-*-strong`)
 *   clear AAA against `text-on-status` AND AAA against the page. The label and
 *   the silhouette are the same ratio here, because each mode paints its fills
 *   on the far side of its own canvas: dark fills under a white label on white,
 *   bright fills under a black label on black. That is the whole reason
 *   `text-on-status` is a per-mode token rather than a literal white;
 * - borders, rings and series marks clear the 3:1 non-text floor (WCAG 1.4.11).
 */

/**
 * Black ink on a white canvas, black borders on every edge, and accents dark
 * enough (relative luminance <= 0.1) that they clear 7:1 both against the canvas
 * and against white text placed on them.
 */
export const highContrastLightTheme: IThemeRGB = {
  // Text colors
  'rgb-text-primary': '0 0 0', // #000000
  'rgb-text-secondary': '0 0 0', // #000000
  'rgb-text-secondary-alt': '0 0 0', // #000000
  'rgb-text-tertiary': '0 0 0', // #000000
  'rgb-text-muted': '0 0 0', // #000000
  'rgb-text-warning': '122 61 0', // #7a3d00
  'rgb-text-destructive': '161 0 0', // #a10000
  'rgb-shimmer-base': '0 0 0', // #000000, 21:1 on white
  'rgb-shimmer-dip': '77 77 77', // #4d4d4d, 8.45:1 on white

  // Link and accent colors
  'rgb-link': '0 0 204', // #0000cc
  'rgb-link-hover': '0 0 128', // #000080
  'rgb-link-visited': '107 0 179', // #6b00b3
  'rgb-accent-primary': '0 80 77', // #00504d
  'rgb-accent-primary-hover': '0 51 48', // #003330

  // Ring colors
  'rgb-ring-primary': '0 0 0', // #000000

  // Header colors
  'rgb-header-primary': '255 255 255', // #ffffff
  'rgb-header-hover': '212 212 212', // #d4d4d4
  'rgb-header-button-hover': '212 212 212', // #d4d4d4

  // Surface colors
  /** Selected state. The fill does not carry WCAG 1.4.11 on its own: the
   *  contrast block in `client/src/style.css` rings every selected row and
   *  navigated menu item in `text-primary`, which is 21:1 against either canvas.
   *  That perimeter is what frees these fills to stay light, so a selected row's
   *  black label clears AAA (15.8:1 and 14.6:1) instead of the 6.25:1 a fill
   *  dark enough to mark itself used to cap it at. `-alt` meets `surface-hover`,
   *  the same place the standard light palette puts it. */
  'rgb-surface-active': '227 227 227', // #e3e3e3
  'rgb-surface-active-alt': '212 212 212', // #d4d4d4
  'rgb-surface-hover': '212 212 212', // #d4d4d4
  'rgb-surface-hover-alt': '184 184 184', // #b8b8b8
  'rgb-surface-composer-hover': '212 212 212', // #d4d4d4
  'rgb-surface-primary': '255 255 255', // #ffffff
  /** The chart widget canvas and its edge, which default to `surface-primary`
   *  and `border-light` elsewhere: here the panel is the plain canvas and its
   *  outline is pure ink, so a widget stays legible without a grey wash. */
  'rgb-chart-widget-surface': '255 255 255', // #ffffff
  'rgb-chart-widget-stroke': '0 0 0', // #000000
  'rgb-surface-primary-alt': '255 255 255', // #ffffff
  'rgb-surface-primary-contrast': '255 255 255', // #ffffff
  'rgb-surface-secondary': '255 255 255', // #ffffff
  'rgb-surface-secondary-alt': '255 255 255', // #ffffff
  'rgb-surface-tertiary': '255 255 255', // #ffffff
  'rgb-surface-tertiary-alt': '255 255 255', // #ffffff
  'rgb-surface-dialog': '255 255 255', // #ffffff
  'rgb-surface-overlay': '0 0 0', // #000000
  'rgb-surface-submit': '0 92 46', // #005c2e
  'rgb-surface-submit-hover': '0 61 30', // #003d1e
  'rgb-surface-destructive': '161 0 0', // #a10000
  'rgb-surface-destructive-hover': '122 0 0', // #7a0000
  'rgb-surface-chat': '255 255 255', // #ffffff
  'rgb-surface-code': '255 255 255', // #ffffff, matching surface-primary-alt
  'rgb-surface-inverted': '0 0 0', // #000000
  'rgb-surface-inverted-hover': '51 51 51', // #333333
  'rgb-text-inverted': '255 255 255', // #ffffff
  'rgb-surface-fixed': '255 255 255', // #ffffff
  'rgb-surface-fixed-hover': '212 212 212', // #d4d4d4
  'rgb-text-fixed': '0 0 0', // #000000

  // Border colors
  'rgb-border-light': '0 0 0', // #000000
  'rgb-border-medium': '0 0 0', // #000000
  'rgb-border-medium-alt': '0 0 0', // #000000
  'rgb-border-heavy': '0 0 0', // #000000
  'rgb-border-xheavy': '0 0 0', // #000000
  'rgb-border-destructive': '161 0 0', // #a10000

  // Status colors
  'rgb-status-success': '0 92 46', // #005c2e
  'rgb-status-success-subtle': '255 255 255', // #ffffff
  'rgb-status-success-border': '0 92 46', // #005c2e
  'rgb-status-success-strong': '0 92 46', // #005c2e
  'rgb-status-info': '0 65 122', // #00417a
  'rgb-status-info-subtle': '255 255 255', // #ffffff
  'rgb-status-info-border': '0 65 122', // #00417a
  'rgb-status-info-strong': '0 65 122', // #00417a
  'rgb-status-warning': '122 61 0', // #7a3d00
  'rgb-status-warning-subtle': '255 255 255', // #ffffff
  'rgb-status-warning-border': '122 61 0', // #7a3d00
  'rgb-status-warning-strong': '122 61 0', // #7a3d00
  'rgb-status-error': '161 0 0', // #a10000
  'rgb-status-error-subtle': '255 255 255', // #ffffff
  'rgb-status-error-border': '161 0 0', // #a10000
  'rgb-status-error-strong': '161 0 0', // #a10000
  'rgb-status-neutral': '0 0 0', // #000000
  'rgb-status-neutral-subtle': '255 255 255', // #ffffff
  'rgb-status-neutral-border': '0 0 0', // #000000
  /** Verified mark: the mode's one blue, 10.31:1 under the white check and the
   *  same against the canvas. */
  'rgb-status-verified': '0 65 122', // #00417a
  'rgb-text-on-status': '255 255 255', // #ffffff

  // Brand colors
  'rgb-brand-purple': '107 0 179', // #6b00b3

  /** Code syntax highlighting at AAA on the white code surface. */
  'rgb-syntax-text': '0 0 0', // #000000
  'rgb-syntax-comment': '77 77 77', // #4d4d4d
  'rgb-syntax-meta': '77 77 77', // #4d4d4d
  'rgb-syntax-builtin': '107 61 0', // #6b3d00
  'rgb-syntax-keyword': '0 61 153', // #003d99
  'rgb-syntax-string': '0 86 61', // #00563d
  'rgb-syntax-attr': '122 20 82', // #7a1452
  'rgb-syntax-title': '143 26 16', // #8f1a10

  /** Categorical series scale. Every slot clears 7:1 on the white canvas and no
   *  two adjacent chromatic slots sit closer than CIE76 dE 50 under normal
   *  vision or dE 45 under simulated deuteranopia. Seven saturated hues is all
   *  this canvas affords at that separation, so slot 8 is the palette's own
   *  neutral text — the stop `resolveTheme` also derives for a theme that
   *  paints its own scale — separated by lightness (21:1 on the canvas, dE 22.9
   *  from its neighbour under deuteranopia) rather than by hue. */
  'rgb-series-1': '11 79 160', // #0b4fa0
  'rgb-series-2': '143 59 0', // #8f3b00
  'rgb-series-3': '0 82 79', // #00524f
  'rgb-series-4': '92 74 0', // #5c4a00
  'rgb-series-5': '148 0 92', // #94005c
  'rgb-series-6': '77 26 153', // #4d1a99
  'rgb-series-7': '15 92 15', // #0f5c0f
  'rgb-series-8': '0 0 0', // #000000 (neutral text stop)

  /** Unchecked switch track. The stock 58%/40% greys land at 2.9:1 and 2.2:1
   *  against these canvases. This clears 3:1 three ways at once: 5.74:1 against
   *  the page and the `surface-primary` thumb, 3.66:1 against the checked
   *  `surface-inverted` track. */
  'rgb-switch-unchecked': '102 102 102', // #666666

  // Presentation
  'rgb-presentation': '255 255 255', // #ffffff
};

/**
 * White ink on a black canvas with white borders, and accents bright enough
 * (relative luminance >= 0.3) that they clear 7:1 both against the canvas and
 * against the black `text-on-status` label placed on them.
 */
export const highContrastDarkTheme: IThemeRGB = {
  // Text colors
  'rgb-text-primary': '255 255 255', // #ffffff
  'rgb-text-secondary': '255 255 255', // #ffffff
  'rgb-text-secondary-alt': '255 255 255', // #ffffff
  'rgb-text-tertiary': '255 255 255', // #ffffff
  'rgb-text-muted': '255 255 255', // #ffffff
  'rgb-text-warning': '255 201 77', // #ffc94d
  'rgb-text-destructive': '255 143 143', // #ff8f8f
  'rgb-shimmer-base': '255 255 255', // #ffffff, 21:1 on black
  'rgb-shimmer-dip': '179 179 179', // #b3b3b3, 10.02:1 on black

  // Link and accent colors
  'rgb-link': '140 200 255', // #8cc8ff
  'rgb-link-hover': '194 224 255', // #c2e0ff
  'rgb-link-visited': '224 179 255', // #e0b3ff
  'rgb-accent-primary': '92 230 219', // #5ce6db
  'rgb-accent-primary-hover': '163 242 236', // #a3f2ec

  // Ring colors
  'rgb-ring-primary': '255 255 255', // #ffffff

  // Header colors
  'rgb-header-primary': '0 0 0', // #000000
  'rgb-header-hover': '61 61 61', // #3d3d3d
  'rgb-header-button-hover': '61 61 61', // #3d3d3d

  // Surface colors
  /** Selected state, the mirror of the light note: the perimeter marks the row,
   *  so these step off the canvas only as far as an AAA white label allows —
   *  14.2:1 and 10.9:1, against the 6.69:1 and 5.49:1 a self-marking fill used
   *  to force. `-alt` meets `surface-hover`, as it does in the light palette. */
  'rgb-surface-active': '43 43 43', // #2b2b2b
  'rgb-surface-active-alt': '61 61 61', // #3d3d3d
  'rgb-surface-hover': '61 61 61', // #3d3d3d
  'rgb-surface-hover-alt': '87 87 87', // #575757
  'rgb-surface-composer-hover': '61 61 61', // #3d3d3d
  'rgb-surface-primary': '0 0 0', // #000000
  /** See the light mode note: the widget takes the plain canvas and a pure-ink
   *  edge rather than the dimmed panel the standard themes use. */
  'rgb-chart-widget-surface': '0 0 0', // #000000
  'rgb-chart-widget-stroke': '255 255 255', // #ffffff
  'rgb-surface-primary-alt': '0 0 0', // #000000
  'rgb-surface-primary-contrast': '0 0 0', // #000000
  'rgb-surface-secondary': '0 0 0', // #000000
  'rgb-surface-secondary-alt': '0 0 0', // #000000
  'rgb-surface-tertiary': '0 0 0', // #000000
  'rgb-surface-tertiary-alt': '0 0 0', // #000000
  'rgb-surface-dialog': '0 0 0', // #000000
  'rgb-surface-overlay': '0 0 0', // #000000
  'rgb-surface-submit': '127 240 179', // #7ff0b3
  'rgb-surface-submit-hover': '163 245 204', // #a3f5cc
  'rgb-surface-destructive': '255 143 143', // #ff8f8f
  'rgb-surface-destructive-hover': '255 179 179', // #ffb3b3
  'rgb-surface-chat': '0 0 0', // #000000
  'rgb-surface-code': '0 0 0', // #000000, matching presentation
  'rgb-surface-inverted': '255 255 255', // #ffffff
  'rgb-surface-inverted-hover': '212 212 212', // #d4d4d4
  'rgb-text-inverted': '0 0 0', // #000000
  'rgb-surface-fixed': '255 255 255', // #ffffff
  'rgb-surface-fixed-hover': '212 212 212', // #d4d4d4
  'rgb-text-fixed': '0 0 0', // #000000

  // Border colors
  'rgb-border-light': '255 255 255', // #ffffff
  'rgb-border-medium': '255 255 255', // #ffffff
  'rgb-border-medium-alt': '255 255 255', // #ffffff
  'rgb-border-heavy': '255 255 255', // #ffffff
  'rgb-border-xheavy': '255 255 255', // #ffffff
  'rgb-border-destructive': '255 143 143', // #ff8f8f

  // Status colors
  'rgb-status-success': '127 240 179', // #7ff0b3
  'rgb-status-success-subtle': '0 0 0', // #000000
  'rgb-status-success-border': '127 240 179', // #7ff0b3
  'rgb-status-success-strong': '127 240 179', // #7ff0b3
  'rgb-status-info': '140 200 255', // #8cc8ff
  'rgb-status-info-subtle': '0 0 0', // #000000
  'rgb-status-info-border': '140 200 255', // #8cc8ff
  'rgb-status-info-strong': '140 200 255', // #8cc8ff
  'rgb-status-warning': '255 201 77', // #ffc94d
  'rgb-status-warning-subtle': '0 0 0', // #000000
  'rgb-status-warning-border': '255 201 77', // #ffc94d
  'rgb-status-warning-strong': '255 201 77', // #ffc94d
  'rgb-status-error': '255 143 143', // #ff8f8f
  'rgb-status-error-subtle': '0 0 0', // #000000
  'rgb-status-error-border': '255 143 143', // #ff8f8f
  'rgb-status-error-strong': '255 143 143', // #ff8f8f
  'rgb-status-neutral': '255 255 255', // #ffffff
  'rgb-status-neutral-subtle': '0 0 0', // #000000
  'rgb-status-neutral-border': '255 255 255', // #ffffff
  /** Verified mark: the mode's one blue, 11.82:1 under the black check and the
   *  same against the canvas. */
  'rgb-status-verified': '140 200 255', // #8cc8ff
  'rgb-text-on-status': '0 0 0', // #000000

  // Brand colors
  'rgb-brand-purple': '224 179 255', // #e0b3ff

  /** Code syntax highlighting at AAA on the black code surface. */
  'rgb-syntax-text': '255 255 255', // #ffffff
  'rgb-syntax-comment': '179 179 179', // #b3b3b3
  'rgb-syntax-meta': '179 179 179', // #b3b3b3
  'rgb-syntax-builtin': '255 201 77', // #ffc94d
  'rgb-syntax-keyword': '140 200 255', // #8cc8ff
  'rgb-syntax-string': '127 240 179', // #7ff0b3
  'rgb-syntax-attr': '255 153 194', // #ff99c2
  'rgb-syntax-title': '255 143 143', // #ff8f8f

  /** Categorical series scale. Every slot clears 9.9:1 on the black canvas and
   *  no two adjacent chromatic slots sit closer than CIE76 dE 37 under normal
   *  vision or dE 42 under simulated deuteranopia. As in the light palette,
   *  slot 8 is the neutral text stop rather than an eighth pastel this canvas
   *  cannot separate: 21:1 on the canvas and dE 26.8 from the nearest slot
   *  under deuteranopia, distinguished by lightness rather than hue. */
  'rgb-series-1': '107 184 255', // #6bb8ff
  'rgb-series-2': '255 179 102', // #ffb366
  'rgb-series-3': '92 230 219', // #5ce6db
  'rgb-series-4': '255 224 102', // #ffe066
  'rgb-series-5': '255 153 194', // #ff99c2
  'rgb-series-6': '200 163 255', // #c8a3ff
  'rgb-series-7': '140 230 140', // #8ce68c
  'rgb-series-8': '255 255 255', // #ffffff (neutral text stop)

  /** Unchecked switch track: 5.32:1 against the page and the `surface-primary`
   *  thumb, 3.95:1 against the checked `surface-inverted` track. */
  'rgb-switch-unchecked': '128 128 128', // #808080

  // Presentation
  'rgb-presentation': '0 0 0', // #000000
};

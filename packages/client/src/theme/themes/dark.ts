import { IThemeRGB } from '../types';

/**
 * Dark theme
 * RGB values extracted from the existing dark mode CSS variables
 */
export const darkTheme: IThemeRGB = {
  // Text colors
  'rgb-text-primary': '236 236 236', // #ececec (gray-100)
  'rgb-text-secondary': '205 205 205', // #cdcdcd (gray-300)
  'rgb-text-secondary-alt': '153 150 150', // #999696 (gray-400)
  'rgb-text-tertiary': '153 150 150', // #999696 (gray-400)
  'rgb-text-muted': '179 182 189', // #b3b6bd (Click UI text.muted)
  'rgb-text-warning': '245 158 11', // #f59e0b (amber-500)
  'rgb-text-destructive': '248 113 113', // #f87171 (red-400)
  'rgb-shimmer-base': '255 255 255', // #ffffff, carried at 0.8 alpha
  'rgb-shimmer-dip': '179 179 179', // #b3b3b3

  // Link and accent colors
  'rgb-link': '96 165 250', // #60a5fa (blue-400)
  'rgb-link-hover': '147 197 253', // #93c5fd (blue-300)
  'rgb-link-visited': '192 132 252', // #c084fc (purple-400)
  'rgb-accent-primary': '65 167 157', // #41a79d
  'rgb-accent-primary-hover': '109 200 185', // #6dc8b9

  // Ring colors (not defined in dark mode, using default)
  'rgb-ring-primary': '89 89 89', // #595959 (gray-500)

  // Header colors
  'rgb-header-primary': '47 47 47', // #2f2f2f (gray-700)
  'rgb-header-hover': '66 66 66', // #424242 (gray-600)
  'rgb-header-button-hover': '47 47 47', // #2f2f2f (gray-700)

  // Surface colors
  'rgb-surface-active': '89 89 89', // #595959 (gray-500)
  'rgb-surface-active-alt': '47 47 47', // #2f2f2f (gray-700)
  'rgb-surface-hover': '57 57 57', // #393939 (gray-650)
  'rgb-surface-hover-alt': '66 66 66', // #424242 (gray-600)
  'rgb-surface-composer-hover': '66 66 66', // #424242 (gray-600)
  'rgb-surface-primary': '13 13 13', // #0d0d0d (gray-900)
  'rgb-chart-widget-surface': '40 40 40', // #282828 (Click UI chart widget)
  'rgb-chart-widget-stroke': '50 50 50', // #323232 (Click UI chart widget)
  'rgb-surface-primary-alt': '23 23 23', // #171717 (gray-850)
  'rgb-surface-primary-contrast': '23 23 23', // #171717 (gray-850)
  'rgb-surface-secondary': '33 33 33', // #212121 (gray-800)
  'rgb-surface-secondary-alt': '33 33 33', // #212121 (gray-800)
  'rgb-surface-tertiary': '47 47 47', // #2f2f2f (gray-700)
  'rgb-surface-tertiary-alt': '47 47 47', // #2f2f2f (gray-700)
  'rgb-surface-dialog': '18 18 18', // #121212 (legacy dark dialog)
  'rgb-surface-overlay': '0 0 0', // #000 (black)
  'rgb-surface-submit': '4 120 87', // #047857 (green-700)
  'rgb-surface-submit-hover': '6 95 70', // #065f46 (green-800)
  'rgb-surface-destructive': '153 27 27', // #991b1b (red-800)
  'rgb-surface-destructive-hover': '127 29 29', // #7f1d1d (red-900)
  'rgb-surface-chat': '47 47 47', // #2f2f2f (gray-700)
  'rgb-surface-code': '33 33 33', // #212121 (gray-800)
  'rgb-surface-inverted': '255 255 255', // #fff (white)
  'rgb-surface-inverted-hover': '236 236 236', // #ececec (gray-100)
  'rgb-text-inverted': '23 23 23', // #171717 (gray-850)
  'rgb-surface-fixed': '255 255 255', // #fff (white) — same in light + dark
  'rgb-surface-fixed-hover': '236 236 236', // #ececec (gray-100) — same in light + dark
  'rgb-text-fixed': '33 33 33', // #212121 (gray-800) — same in light + dark

  // Border colors
  'rgb-border-light': '47 47 47', // #2f2f2f (gray-700)
  'rgb-border-medium': '66 66 66', // #424242 (gray-600)
  'rgb-border-medium-alt': '66 66 66', // #424242 (gray-600)
  'rgb-border-heavy': '89 89 89', // #595959 (gray-500)
  'rgb-border-xheavy': '153 150 150', // #999696 (gray-400)
  'rgb-border-destructive': '239 68 68', // #ef4444 (red-500)

  // Status colors
  'rgb-status-success': '110 231 183', // #6ee7b7 (green-300)
  'rgb-status-success-subtle': '2 44 34', // #022c22 (green-950)
  'rgb-status-success-border': '6 95 70', // #065f46 (green-800)
  /** Not `green-800` like its border twin: this fill also paints bare marks
   *  (selection checks, the version timeline rail, prompt chips) that have to
   *  clear 3:1 against the #212121 panel, and green-800 reached only 2.10:1
   *  there. Balanced instead, the same way light's `#02855e` is: 4.55:1 under
   *  the white `text-on-status` label and 3.54:1 against the panel. */
  'rgb-status-success-strong': '8 135 89', // #088759
  'rgb-status-info': '147 197 253', // #93c5fd (blue-300)
  'rgb-status-info-subtle': '23 37 84', // #172554 (blue-950)
  'rgb-status-info-border': '30 64 175', // #1e40af (blue-800)
  'rgb-status-info-strong': '66 66 66', // #424242 (gray-600)
  'rgb-status-warning': '252 211 77', // #fcd34d (amber-300)
  'rgb-status-warning-subtle': '69 26 3', // #451a03 (amber-950)
  'rgb-status-warning-border': '146 64 14', // #92400e (amber-800)
  'rgb-status-warning-strong': '146 64 14', // #92400e (amber-800)
  'rgb-status-error': '252 165 165', // #fca5a5 (red-300)
  'rgb-status-error-subtle': '69 10 10', // #450a0a (red-950)
  'rgb-status-error-border': '153 27 27', // #991b1b (red-800)
  'rgb-status-error-strong': '153 27 27', // #991b1b (red-800)
  'rgb-status-neutral': '205 205 205', // #cdcdcd (gray-300)
  'rgb-status-neutral-subtle': '33 33 33', // #212121 (gray-800)
  'rgb-status-neutral-border': '47 47 47', // #2f2f2f (gray-700)
  /** Verified mark. Not `status-info`'s `blue-300`, which is a text hue and
   *  leaves a white check at 1.35:1. The card it sits on is `surface-dialog`
   *  at rest and `surface-tertiary` (#2f2f2f) on hover, and that hover is the
   *  binding constraint: `#0b74d4` held the panel at 3.42:1 but fell to 2.85:1
   *  there. Both relationships are graphical (WCAG 1.4.11): 3.23:1 against the
   *  hover surface, 4.52:1 against the resting dialog, and 4.14:1 under the
   *  white `text-on-status` check. No hue clears 3:1 on #2f2f2f and 4.5:1
   *  under a white check at once — the check would have to stop being white. */
  'rgb-status-verified': '26 127 216', // #1a7fd8
  'rgb-text-on-status': '255 255 255', // #fff (white)

  // Brand colors
  'rgb-brand-purple': '171 104 255', // #ab68ff

  /** Code syntax highlighting, measured against the `surface-code` fill. The
   *  comment and meta values are the flattened equivalents of the alpha-blended
   *  whites this palette used before it was tokenized: 50% and 60% white over
   *  the #212121 code surface. */
  'rgb-syntax-text': '255 255 255', // #fff (white)
  'rgb-syntax-comment': '144 144 144', // #909090
  'rgb-syntax-meta': '166 166 166', // #a6a6a6
  'rgb-syntax-builtin': '233 149 12', // #e9950c
  'rgb-syntax-keyword': '46 149 211', // #2e95d3
  'rgb-syntax-string': '0 166 125', // #00a67d
  'rgb-syntax-attr': '223 48 121', // #df3079
  'rgb-syntax-title': '242 44 61', // #f22c3d

  /** Categorical series scale — the same eight hues stepped for the #212121
   *  surface: worst adjacent CVD ΔE 13.0, normal-vision ΔE 19.0, all ≥ 3:1.
   *  Slot 8 is muted rather than the light mode's saturated indigo because a
   *  slot also fills a badge chip under `text-on-status` white: #8c98e6 carried
   *  that glyph at only 2.71:1, this reads 3.66:1 and still clears 3.66:1 on
   *  every series surface. */
  'rgb-series-1': '9 140 238', // #098cee (cerulean)
  'rgb-series-2': '217 87 35', // #d95723 (orange)
  'rgb-series-3': '6 158 152', // #069e98 (aqua)
  'rgb-series-4': '200 133 12', // #c8850c (amber)
  'rgb-series-5': '213 82 130', // #d55282 (magenta)
  'rgb-series-6': '171 104 254', // #ab68fe (violet)
  'rgb-series-7': '80 167 49', // #50a731 (green)
  'rgb-series-8': '120 130 190', // #8082be (indigo)

  /** Unchecked switch track. 3.38:1 against the page and the `surface-primary`
   *  thumb, 5.74:1 against the checked `surface-inverted` track. */
  'rgb-switch-unchecked': '102 102 102', // #666666

  // Presentation
  'rgb-presentation': '33 33 33', // #212121 (gray-800)
};

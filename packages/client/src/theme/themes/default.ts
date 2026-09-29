import { IThemeRGB } from '../types';

/**
 * Default light theme
 * RGB values extracted from the existing CSS variables
 */
export const defaultTheme: IThemeRGB = {
  // Text colors
  'rgb-text-primary': '33 33 33', // #212121 (gray-800)
  'rgb-text-secondary': '66 66 66', // #424242 (gray-600)
  'rgb-text-secondary-alt': '89 89 89', // #595959 (gray-500)
  'rgb-text-tertiary': '89 89 89', // #595959 (gray-500)
  'rgb-text-muted': '105 110 121', // #696e79 (Click UI text.muted)
  'rgb-text-warning': '180 83 9', // #b45309 (amber-700)
  'rgb-text-destructive': '220 38 38', // #dc2626 (red-600)
  'rgb-shimmer-base': '33 33 33', // #212121 (gray-800), matching text-primary
  'rgb-shimmer-dip': '129 130 134', // #818286

  // Link and accent colors
  'rgb-link': '37 99 235', // #2563eb (blue-600)
  'rgb-link-hover': '29 78 216', // #1d4ed8 (blue-700)
  'rgb-link-visited': '147 51 234', // #9333ea (purple-600)
  'rgb-accent-primary': '18 110 107', // #126e6b
  'rgb-accent-primary-hover': '10 79 83', // #0a4f53

  // Ring colors
  'rgb-ring-primary': '89 89 89', // #595959 (gray-500)

  // Header colors
  'rgb-header-primary': '255 255 255', // #fff (white)
  'rgb-header-hover': '247 247 248', // #f7f7f8 (gray-50)
  'rgb-header-button-hover': '247 247 248', // #f7f7f8 (gray-50)

  // Surface colors
  'rgb-surface-active': '236 236 236', // #ececec (gray-100)
  'rgb-surface-active-alt': '227 227 227', // #e3e3e3 (gray-200)
  'rgb-surface-hover': '227 227 227', // #e3e3e3 (gray-200)
  'rgb-surface-hover-alt': '205 205 205', // #cdcdcd (gray-300)
  'rgb-surface-composer-hover': '227 227 227', // #e3e3e3 (gray-200)
  'rgb-surface-primary': '255 255 255', // #fff (white)
  'rgb-chart-widget-surface': '255 255 255', // #fff (Click UI chart widget)
  'rgb-chart-widget-stroke': '230 231 233', // #e6e7e9 (Click UI chart widget)
  'rgb-surface-primary-alt': '247 247 248', // #f7f7f8 (gray-50)
  'rgb-surface-primary-contrast': '236 236 236', // #ececec (gray-100)
  'rgb-surface-secondary': '247 247 248', // #f7f7f8 (gray-50)
  'rgb-surface-secondary-alt': '227 227 227', // #e3e3e3 (gray-200)
  'rgb-surface-tertiary': '236 236 236', // #ececec (gray-100)
  'rgb-surface-tertiary-alt': '255 255 255', // #fff (white)
  'rgb-surface-dialog': '255 255 255', // #fff (white)
  'rgb-surface-overlay': '89 89 89', // #595959 (gray-500)
  'rgb-surface-submit': '4 120 87', // #047857 (green-700)
  'rgb-surface-submit-hover': '6 95 70', // #065f46 (green-800)
  'rgb-surface-destructive': '185 28 28', // #b91c1c (red-700)
  'rgb-surface-destructive-hover': '153 27 27', // #991b1b (red-800)
  'rgb-surface-chat': '255 255 255', // #fff (white)
  'rgb-surface-code': '247 247 248', // #f7f7f8 (gray-50)
  'rgb-surface-inverted': '23 23 23', // #171717 (gray-850)
  'rgb-surface-inverted-hover': '47 47 47', // #2f2f2f (gray-700)
  'rgb-text-inverted': '255 255 255', // #fff (white)
  'rgb-surface-fixed': '255 255 255', // #fff (white) — same in light + dark
  'rgb-surface-fixed-hover': '236 236 236', // #ececec (gray-100) — same in light + dark
  'rgb-text-fixed': '33 33 33', // #212121 (gray-800) — same in light + dark

  // Border colors
  'rgb-border-light': '227 227 227', // #e3e3e3 (gray-200)
  'rgb-border-medium': '205 205 205', // #cdcdcd (gray-300)
  'rgb-border-medium-alt': '205 205 205', // #cdcdcd (gray-300)
  'rgb-border-heavy': '153 150 150', // #999696 (gray-400)
  'rgb-border-xheavy': '89 89 89', // #595959 (gray-500)
  'rgb-border-destructive': '220 38 38', // #dc2626 (red-600)

  // Status colors
  'rgb-status-success': '4 120 87', // #047857 (green-700)
  'rgb-status-success-subtle': '236 253 245', // #ecfdf5 (green-50)
  'rgb-status-success-border': '110 231 183', // #6ee7b7 (green-300)
  'rgb-status-success-strong': '2 133 94', // #02855e
  'rgb-status-info': '37 99 235', // #2563eb (blue-600)
  'rgb-status-info-subtle': '239 246 255', // #eff6ff (blue-50)
  'rgb-status-info-border': '147 197 253', // #93c5fd (blue-300)
  'rgb-status-info-strong': '89 89 89', // #595959 (gray-500)
  'rgb-status-warning': '180 83 9', // #b45309 (amber-700)
  'rgb-status-warning-subtle': '255 251 235', // #fffbeb (amber-50)
  'rgb-status-warning-border': '252 211 77', // #fcd34d (amber-300)
  'rgb-status-warning-strong': '199 82 9', // #c75209
  'rgb-status-error': '185 28 28', // #b91c1c (red-700)
  'rgb-status-error-subtle': '254 242 242', // #fef2f2 (red-50)
  'rgb-status-error-border': '252 165 165', // #fca5a5 (red-300)
  'rgb-status-error-strong': '224 47 31', // #e02f1f
  'rgb-status-neutral': '66 66 66', // #424242 (gray-600)
  'rgb-status-neutral-subtle': '236 236 236', // #ececec (gray-100)
  'rgb-status-neutral-border': '205 205 205', // #cdcdcd (gray-300)
  /** Verified mark. `blue-600` doubles as `status-info` here, and that is the
   *  point: one blue for "this is informational/first-party", 5.17:1 under the
   *  white label and 4.83:1 against the panel. */
  'rgb-status-verified': '37 99 235', // #2563eb (blue-600)
  'rgb-text-on-status': '255 255 255', // #fff (white)

  // Brand colors
  'rgb-brand-purple': '126 34 206', // #7e22ce (purple-700)

  /** Code syntax highlighting, measured against the `surface-code` fill. */
  'rgb-syntax-text': '33 33 33', // #212121 (gray-800)
  'rgb-syntax-comment': '89 89 89', // #595959 (gray-500)
  'rgb-syntax-meta': '66 66 66', // #424242 (gray-600)
  'rgb-syntax-builtin': '154 103 0', // #9a6700
  'rgb-syntax-keyword': '5 80 174', // #0550ae
  'rgb-syntax-string': '10 123 98', // #0a7b62
  'rgb-syntax-attr': '154 47 106', // #9a2f6a
  'rgb-syntax-title': '180 35 24', // #b42318

  /** Categorical series scale. Steps clear 3:1 against BOTH the popover surface
   *  and the #ececec meter track, with worst adjacent CVD ΔE 12.4 and worst
   *  adjacent normal-vision ΔE 19.0. Slot order is the CVD-safety mechanism:
   *  indigo(8) sits beside green(7) because blue separates from green under
   *  protanopia/deuteranopia where red would not. */
  'rgb-series-1': '5 110 189', // #056ebd (cerulean)
  'rgb-series-2': '233 86 13', // #e9560d (orange)
  'rgb-series-3': '0 148 142', // #00948e (aqua)
  'rgb-series-4': '182 123 5', // #b67b05 (amber)
  'rgb-series-5': '216 90 142', // #d85a8e (magenta)
  'rgb-series-6': '126 35 205', // #7e23cd (violet)
  'rgb-series-7': '1 131 1', // #018301 (green)
  'rgb-series-8': '63 81 181', // #3f51b5 (indigo)

  /** Unchecked switch track. 3.03:1 against the white page and the
   *  `surface-primary` thumb, 5.91:1 against the checked `surface-inverted`
   *  track, so the control reads in either state. */
  'rgb-switch-unchecked': '148 148 148', // #949494

  // Presentation
  'rgb-presentation': '255 255 255', // #fff (white)
};

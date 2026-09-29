/**
 * Single source of truth for the Tailwind semantic color palette.
 *
 * Both Tailwind configs consume this so the `client` SPA and the
 * `@librechat/client` package generate identical color utilities and can
 * never drift apart:
 *   - client/tailwind.config.cjs
 *   - packages/client/tailwind.config.js
 *
 * Semantic tokens resolve to CSS custom properties defined in
 * client/src/style.css (`html`, `.dark`, `.gizmo` blocks). Those variables hold
 * bare `R G B` channel triplets, so `cssVar` wraps them as
 * `rgb(var(--x) / <alpha-value>)`. This makes opacity modifiers work, e.g.
 * `bg-surface-primary/50`. Tokens with an intrinsic alpha use a companion
 * `--x-alpha` variable that is multiplied by Tailwind's opacity modifier. Every
 * token is an `R G B` triplet, so a direct `var(--token)` usage in plain CSS
 * must wrap the channel triplet itself, e.g. `color: rgb(var(--text-primary))`.
 */

const palette = {
  gray: {
    20: '#ececf1',
    50: '#f7f7f8',
    100: '#ececec',
    200: '#e3e3e3',
    300: '#cdcdcd',
    400: '#999696',
    500: '#595959',
    600: '#424242',
    650: '#393939',
    700: '#2f2f2f',
    800: '#212121',
    850: '#171717',
    900: '#0d0d0d',
  },
  green: {
    50: '#f1f9f7',
    100: '#def2ed',
    200: '#a6e5d6',
    300: '#6dc8b9',
    400: '#41a79d',
    500: '#10a37f',
    550: '#349072',
    600: '#126e6b',
    700: '#0a4f53',
    800: '#06373e',
    900: '#031f29',
  },
};

const cssVar = (name) => `rgb(var(${name}) / <alpha-value>)`;
const cssVarWithAlpha = (name) => `rgb(var(${name}) / calc(var(${name}-alpha, 1) * <alpha-value>))`;

/**
 * Creates the Tailwind `theme.extend.colors` object backed by CSS variables.
 * This allows dynamic theme switching by changing CSS variable values at
 * runtime (see ThemeProvider / applyTheme).
 */
function createTailwindColors() {
  return {
    ...palette,

    'brand-purple': cssVar('--brand-purple'),
    presentation: cssVar('--presentation'),

    'text-primary': cssVar('--text-primary'),
    'text-secondary': cssVar('--text-secondary'),
    'text-secondary-alt': cssVar('--text-secondary-alt'),
    'text-tertiary': cssVar('--text-tertiary'),
    'text-muted': cssVar('--text-muted'),
    'chart-widget-surface': cssVar('--chart-widget-surface'),
    'chart-widget-stroke': cssVar('--chart-widget-stroke'),
    'text-warning': cssVar('--text-warning'),
    'text-destructive': cssVar('--text-destructive'),

    link: cssVar('--link'),
    'link-hover': cssVar('--link-hover'),
    'link-visited': cssVar('--link-visited'),

    'accent-primary': cssVar('--accent-primary'),
    'accent-primary-hover': cssVar('--accent-primary-hover'),

    'ring-primary': cssVar('--ring-primary'),

    'header-primary': cssVar('--header-primary'),
    'header-hover': cssVar('--header-hover'),
    'header-button-hover': cssVar('--header-button-hover'),

    'surface-active': cssVar('--surface-active'),
    'surface-active-alt': cssVar('--surface-active-alt'),
    'surface-hover': cssVar('--surface-hover'),
    'surface-hover-alt': cssVar('--surface-hover-alt'),
    'surface-composer-hover': cssVar('--surface-composer-hover'),
    'surface-primary': cssVar('--surface-primary'),
    'surface-primary-alt': cssVar('--surface-primary-alt'),
    'surface-primary-contrast': cssVar('--surface-primary-contrast'),
    'surface-secondary': cssVar('--surface-secondary'),
    'surface-secondary-alt': cssVar('--surface-secondary-alt'),
    'surface-tertiary': cssVar('--surface-tertiary'),
    'surface-tertiary-alt': cssVar('--surface-tertiary-alt'),
    'surface-dialog': cssVar('--surface-dialog'),
    'surface-overlay': cssVar('--surface-overlay'),
    'surface-submit': cssVar('--surface-submit'),
    'surface-submit-hover': cssVar('--surface-submit-hover'),
    'surface-destructive': cssVar('--surface-destructive'),
    'surface-destructive-hover': cssVar('--surface-destructive-hover'),
    'surface-chat': cssVar('--surface-chat'),
    'surface-code': cssVar('--surface-code'),
    'surface-qr': cssVar('--surface-qr'),
    'surface-inverted': cssVar('--surface-inverted'),
    'surface-inverted-hover': cssVar('--surface-inverted-hover'),
    'text-inverted': cssVar('--text-inverted'),
    'surface-fixed': cssVar('--surface-fixed'),
    'surface-fixed-hover': cssVar('--surface-fixed-hover'),
    'text-fixed': cssVar('--text-fixed'),

    'border-light': cssVarWithAlpha('--border-light'),
    'border-medium': cssVarWithAlpha('--border-medium'),
    'border-medium-alt': cssVar('--border-medium-alt'),
    'border-heavy': cssVarWithAlpha('--border-heavy'),
    'border-xheavy': cssVarWithAlpha('--border-xheavy'),
    'border-destructive': cssVar('--border-destructive'),

    'status-success': cssVar('--status-success'),
    'status-success-subtle': cssVar('--status-success-subtle'),
    'status-success-border': cssVar('--status-success-border'),
    'status-success-strong': cssVar('--status-success-strong'),
    'status-info': cssVar('--status-info'),
    'status-info-subtle': cssVar('--status-info-subtle'),
    'status-info-border': cssVar('--status-info-border'),
    'status-info-strong': cssVar('--status-info-strong'),
    'status-warning': cssVar('--status-warning'),
    'status-warning-subtle': cssVar('--status-warning-subtle'),
    'status-warning-border': cssVar('--status-warning-border'),
    'status-warning-strong': cssVar('--status-warning-strong'),
    'status-error': cssVar('--status-error'),
    'status-error-subtle': cssVar('--status-error-subtle'),
    'status-error-border': cssVar('--status-error-border'),
    'status-error-strong': cssVar('--status-error-strong'),
    'status-neutral': cssVar('--status-neutral'),
    'status-neutral-subtle': cssVar('--status-neutral-subtle'),
    'status-neutral-border': cssVar('--status-neutral-border'),
    'status-verified': cssVar('--status-verified'),
    'text-on-status': cssVar('--text-on-status'),

    'series-1': cssVar('--series-1'),
    'series-2': cssVar('--series-2'),
    'series-3': cssVar('--series-3'),
    'series-4': cssVar('--series-4'),
    'series-5': cssVar('--series-5'),
    'series-6': cssVar('--series-6'),
    'series-7': cssVar('--series-7'),
    'series-8': cssVar('--series-8'),

    'switch-unchecked': cssVar('--switch-unchecked'),
  };
}

module.exports = { createTailwindColors };

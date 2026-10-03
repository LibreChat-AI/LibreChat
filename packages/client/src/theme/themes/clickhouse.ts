import type { IThemeAppearance, ThemeDefinition, IThemeRGB } from '../types';

/**
 * ClickHouse reference theme, built from Click UI's design tokens
 * (github.com/ClickHouse/click-ui, `src/theme/tokens/variables.light.ts` and
 * `variables.dark.ts` at tag v0.12.0, e2b3d213798f4223122581a75ebc8dd91e47fd9f). The tokens it
 * cites are pinned in `clickui.json`, and `clickui.spec.ts` fails on drift in either one.
 *
 * This is the deliberately different theme that proves the engine repaints the
 * app from data alone: no component reads it by name, and LibreChat's defaults
 * are untouched. Each comment names the Click UI token a value comes from; paths
 * without a prefix are under `global.color` (or `click.global.color` for `text.warning` and
 * `text.danger`), `palette.*` is Click UI's ramp, and component paths are under `click`.
 *
 * Both maps are complete, so nothing falls back to the LibreChat palette. Where
 * a verbatim Click UI value missed a contrast floor in `clickhouse.spec.ts` or
 * `semanticTokens.spec.ts`, the value moves along the same Click UI ramp and the
 * comment records the step and the ratio it replaced.
 *
 * `text-on-status` is one label per mode over every solid fill. Dark mode keeps
 * the brand yellow on `surface-submit`, which forces a near-black label, so the
 * destructive and `status-*-strong` fills there are the bright end of their
 * ramps, the same trade `highContrastDarkTheme` makes.
 */

export const clickHouseLightTheme: IThemeRGB = {
  // Text colors
  'rgb-text-primary': '22 21 23', // #161517 (text.default)
  /** Secondary and tertiary copy also sit on the status fills (the chat error
   *  box, the route error boundary, the sign-in notices, the deleted rows of a
   *  diff), where text.muted #696e79 measures 4.05:1 on
   *  feedback.danger.background. One step down the slate ramp is Click UI's own
   *  feedback.neutral.foreground. `text-muted` never meets a status fill, so it
   *  keeps text.muted. */
  'rgb-text-secondary': '83 87 95', // #53575f (palette.slate.700)
  'rgb-text-secondary-alt': '83 87 95', // #53575f (palette.slate.700)
  'rgb-text-tertiary': '83 87 95', // #53575f (palette.slate.700)
  'rgb-text-muted': '105 110 121', // #696e79 (text.muted)
  'rgb-badge-label': '105 110 121', // #696e79 (badge.opaque.color.text.default)
  'rgb-text-warning': '163 60 0', // #a33c00 (text.warning)
  'rgb-text-destructive': '193 0 0', // #c10000 (text.danger)
  'rgb-shimmer-base': '22 21 23', // #161517 (text.default, matching text-primary)
  'rgb-shimmer-dip': '128 134 145', // #808691 (palette.slate.500)

  // Link and accent colors
  'rgb-link': '29 100 236', // #1d64ec (palette.info.500, one step past text.link.default #437eef (3.84:1 on white))
  'rgb-link-hover': '16 78 198', // #104ec6 (text.link.hover)
  'rgb-link-visited': '136 0 204', // #8800cc (palette.violet.600)
  'rgb-link-prose': '29 100 236', // #1d64ec (palette.info.500, matching link)
  'rgb-accent-primary': '21 21 21', // #151515 (accent.default)
  'rgb-accent-primary-hover': '50 50 50', // #323232 (palette.neutral.712)

  // Ring colors
  'rgb-ring-primary': '67 126 239', // #437eef (outline.default)
  'rgb-focus-outline': '67 126 239', // #437eef (outline.default)
  'rgb-focus-control': '67 126 239', // #437eef (outline.default)

  // Header colors
  'rgb-header-primary': '255 255 255', // #ffffff (background.default)
  'rgb-header-hover': '246 247 250', // #f6f7fa (background.muted)
  'rgb-header-button-hover': '246 247 250', // #f6f7fa (background.muted)

  // Surface colors
  'rgb-surface-active': '230 231 233', // #e6e7e9 (palette.slate.100)
  'rgb-surface-active-alt': '204 207 211', // #cccfd3 (palette.slate.200)
  'rgb-surface-hover': '230 231 233', // #e6e7e9 (palette.slate.100)
  'rgb-surface-hover-alt': '204 207 211', // #cccfd3 (palette.slate.200)
  'rgb-surface-pressed': '221 222 225', // #dddee1 (button.iconButton.color.primary.background.active)
  'rgb-surface-composer-hover': '230 231 233', // #e6e7e9 (palette.slate.100)
  'rgb-surface-primary': '255 255 255', // #ffffff (background.default)
  'rgb-chart-widget-surface': '255 255 255', // #ffffff (background.default)
  'rgb-chart-widget-stroke': '230 231 233', // #e6e7e9 (stroke.default)
  'rgb-surface-primary-alt': '246 247 250', // #f6f7fa (background.split)
  'rgb-surface-primary-contrast': '230 231 233', // #e6e7e9 (palette.slate.100)
  'rgb-surface-secondary': '246 247 250', // #f6f7fa (background.muted)
  'rgb-surface-secondary-alt': '230 231 233', // #e6e7e9 (palette.slate.100)
  'rgb-surface-tertiary': '246 247 250', // #f6f7fa (background.muted)
  'rgb-surface-tertiary-alt': '255 255 255', // #ffffff (background.default)
  'rgb-surface-dialog': '255 255 255', // #ffffff (background.default)
  'rgb-dialog-title': '30 29 31', // #1e1d1f (dialog.color.title.default, lch(11.126 1.374 305.43))
  'rgb-surface-overlay': '21 21 21', // #151515 (dialog.color.opaqueBackground, lch(6.7738 0 none))
  'rgb-surface-media-overlay': '0 0 0', // #000000 (no Click UI media scrim)
  'rgb-text-on-media': '255 255 255', // #ffffff (palette.neutral.0)
  'rgb-surface-submit': '21 21 21', // #151515 (accent.default)
  'rgb-surface-submit-hover': '50 50 50', // #323232 (palette.neutral.712)
  'rgb-surface-destructive': '193 0 0', // #c10000 (palette.danger.600)
  'rgb-surface-destructive-hover': '145 0 0', // #910000 (palette.danger.700)
  'rgb-surface-chat': '255 255 255', // #ffffff (background.default)
  'rgb-surface-code': '246 247 250', // #f6f7fa (codeblock.lightMode.color.background.default)
  'rgb-surface-code-body': '246 247 250', // #f6f7fa (codeblock.lightMode.color.background.default)
  'rgb-surface-qr': '255 255 255', // #ffffff (palette.neutral.0)
  'rgb-surface-inverted': '21 21 21', // #151515 (palette.neutral.900)
  'rgb-surface-inverted-hover': '50 50 50', // #323232 (palette.neutral.712)
  'rgb-surface-inverted-pressed': '22 21 23', // #161517 (button.basic.color.primary.background.active)
  /** The button's own primary fill, apart from the `#151515` its checkbox and switch share. */
  'rgb-button-primary': '48 46 50', // #302e32 (button.basic.color.primary.background.default)
  'rgb-button-primary-hover': '67 70 76', // #43464c (button.basic.color.primary.background.hover)
  'rgb-text-inverted': '255 255 255', // #ffffff (palette.neutral.0)
  'rgb-surface-fixed': '255 255 255', // #ffffff (palette.neutral.0, same in light and dark)
  'rgb-surface-fixed-hover': '230 231 233', // #e6e7e9 (palette.slate.100, same in light and dark)
  'rgb-text-fixed': '22 21 23', // #161517 (palette.slate.900, same in light and dark)

  // Border colors
  'rgb-border-light': '230 231 233', // #e6e7e9 (stroke.default)
  'rgb-border-medium': '230 231 233', // #e6e7e9 (stroke.default)
  'rgb-border-medium-alt': '230 231 233', // #e6e7e9 (stroke.default)
  'rgb-border-heavy': '179 182 189', // #b3b6bd (stroke.intense)
  'rgb-drawer-edge': '246 247 250', // #f6f7fa (background.split, the drawer's own fill)
  'rgb-border-xheavy': '128 134 145', // #808691 (palette.slate.500, two steps past stroke.intense #b3b6bd (2.03:1 on white))
  'rgb-border-destructive': '193 0 0', // #c10000 (palette.danger.600)
  'rgb-border-control': '128 134 145', // #808691 (palette.slate.500, 3.42:1 on background.muted)
  'rgb-border-field-focus': '22 21 23', // #161517 (field.color.stroke.active)
  'rgb-field-fill': '251 252 255', // #fbfcff (field.color.background.default)
  'rgb-field-text': '48 46 50', // #302e32 (field.color.text.default)
  'rgb-surface-disabled': '223 223 223', // #dfdfdf (button.basic.color.primary.background.disabled)
  'rgb-text-disabled': '160 160 160', // #a0a0a0 (text.disabled)
  'rgb-border-disabled': '223 223 223', // #dfdfdf (field.color.stroke.disabled)

  // Status colors
  'rgb-status-success': '0 97 8', // #006108 (palette.success.800, one step past feedback.success.foreground #008a0b (4.27:1 on its fill))
  'rgb-status-success-subtle': '229 255 232', // #e5ffe8 (feedback.success.background)
  'rgb-status-success-border': '153 255 161', // #99ffa1 (palette.success.200)
  'rgb-status-success-strong': '0 138 11', // #008a0b (feedback.success.foreground)
  'rgb-status-info': '16 78 198', // #104ec6 (palette.info.600, two steps past feedback.info.foreground #437eef (3.32:1 on its fill))
  'rgb-status-info-subtle': '231 239 253', // #e7effd (feedback.info.background)
  'rgb-status-info-border': '161 190 247', // #a1bef7 (palette.info.200)
  'rgb-status-info-strong': '16 78 198', // #104ec6 (palette.info.600)
  'rgb-status-warning': '163 60 0', // #a33c00 (feedback.warning.foreground)
  'rgb-status-warning-subtle': '255 226 209', // #ffe2d1 (feedback.warning.background)
  'rgb-status-warning-border': '255 184 143', // #ffb88f (palette.warning.200)
  'rgb-status-warning-strong': '163 60 0', // #a33c00 (palette.warning.700)
  'rgb-status-error': '193 0 0', // #c10000 (feedback.danger.foreground)
  'rgb-status-error-subtle': '255 221 221', // #ffdddd (feedback.danger.background)
  'rgb-status-error-border': '255 152 152', // #ff9898 (palette.danger.200)
  'rgb-status-error-strong': '193 0 0', // #c10000 (palette.danger.600)
  'rgb-status-neutral': '83 87 95', // #53575f (feedback.neutral.foreground)
  'rgb-status-neutral-subtle': '246 247 250', // #f6f7fa (feedback.neutral.background)
  'rgb-status-neutral-border': '230 231 233', // #e6e7e9 (feedback.neutral.stroke)
  'rgb-status-verified': '16 78 198', // #104ec6 (palette.info.600, matching status-info)
  'rgb-text-on-status': '255 255 255', // #ffffff (palette.neutral.0)

  // Brand colors
  'rgb-brand-purple': '136 0 204', // #8800cc (palette.violet.600)
  'rgb-avatar-fill': '105 110 121', // #696e79 (avatar.color.background.default)
  'rgb-avatar-text': '255 255 255', // #ffffff (avatar.color.text.default)
  'rgb-avatar-placeholder': '246 247 250', // #f6f7fa (background.muted)
  'rgb-avatar-edge': '240 246 252', // #f0f6fc (Click UI avatars draw no edge)
  'rgb-illustration-subtle': '161 190 247', // #a1bef7 (palette.info.200)
  'rgb-illustration': '67 126 239', // #437eef (palette.info.400)
  'rgb-illustration-strong': '16 78 198', // #104ec6 (palette.info.600)
  'rgb-file-document': '204 0 153', // #cc0099 (palette.fuchsia.600)
  'rgb-file-sheet': '0 138 11', // #008a0b (palette.success.700)
  'rgb-file-code': '214 79 0', // #d64f00 (palette.warning.600)
  'rgb-file-artifact': '48 46 50', // #302e32 (palette.slate.800)
  'rgb-file-audio': '138 105 0', // #8a6900 (palette.sunrise.700)
  'rgb-file-video': '136 0 204', // #8800cc (palette.violet.600)
  'rgb-file-generic': '16 78 198', // #104ec6 (palette.info.600)
  'rgb-file-ink': '255 255 255', // #ffffff (palette.neutral.0)

  // Code syntax
  'rgb-syntax-text': '40 40 40', // #282828 (codeblock.lightMode.color.text.default)
  'rgb-syntax-comment': '105 110 121', // #696e79 (text.muted)
  'rgb-syntax-meta': '83 87 95', // #53575f (palette.slate.700)
  'rgb-syntax-builtin': '138 105 0', // #8a6900 (palette.sunrise.700)
  'rgb-syntax-keyword': '16 78 198', // #104ec6 (palette.info.600)
  'rgb-syntax-string': '0 97 8', // #006108 (palette.success.800)
  'rgb-syntax-attr': '153 0 115', // #990073 (palette.fuchsia.700)
  'rgb-syntax-title': '163 60 0', // #a33c00 (palette.warning.700)

  // Series
  'rgb-series-1': '67 126 239', // #437eef (chart.default.blue)
  'rgb-series-2': '245 90 0', // #f55a00 (palette.warning.500, one step past chart.default.orange #ff7729 (2.65:1 on white))
  'rgb-series-3': '0 138 11', // #008a0b (palette.success.700, in place of chart.default.green #00e513 (1.72:1 on white))
  'rgb-series-4': '251 50 201', // #fb32c9 (chart.default.fuchsia)
  'rgb-series-5': '178 136 0', // #b28800 (palette.sunrise.600, in place of chart.default.yellow #eef400 (1.19:1 on white))
  'rgb-series-6': '187 51 255', // #bb33ff (chart.default.violet)
  'rgb-series-7': '0 133 153', // #008599 (palette.babyblue.600, in place of chart.default.babyblue #00cbeb (1.95:1 on white))
  'rgb-series-8': '8 155 131', // #089b83 (chart.default.teal)

  // Switch
  'rgb-switch-unchecked': '128 134 145', // #808691 (palette.slate.500)
  'rgb-switch-thumb': '255 255 255', // #ffffff (switch.color.indicator.default)

  // Table
  'rgb-table-header-text': '22 21 23', // #161517 (table.header.color.title.default)
  'rgb-table-header-fill': '246 247 250', // #f6f7fa (table.header.color.background.default)

  // Presentation
  'rgb-presentation': '255 255 255', // #ffffff (background.default)
};

export const clickHouseDarkTheme: IThemeRGB = {
  // Text colors
  'rgb-text-primary': '255 255 255', // #ffffff (text.default)
  'rgb-text-secondary': '179 182 189', // #b3b6bd (text.muted)
  'rgb-text-secondary-alt': '179 182 189', // #b3b6bd (text.muted)
  'rgb-text-tertiary': '179 182 189', // #b3b6bd (text.muted)
  'rgb-text-muted': '179 182 189', // #b3b6bd (text.muted)
  'rgb-badge-label': '179 182 189', // #b3b6bd (badge.opaque.color.text.default)
  'rgb-text-warning': '255 184 143', // #ffb88f (text.warning)
  'rgb-text-destructive': '255 186 186', // #ffbaba (text.danger)
  'rgb-shimmer-base': '255 255 255', // #ffffff (text.default, matching text-primary)
  'rgb-shimmer-dip': '179 182 189', // #b3b6bd (text.muted)

  // Link and accent colors
  'rgb-link': '250 255 105', // #faff69 (text.link.default)
  'rgb-link-hover': '254 255 194', // #feffc2 (text.link.hover)
  'rgb-link-visited': '204 102 255', // #cc66ff (palette.violet.300)
  'rgb-link-prose': '250 255 105', // #faff69 (text.link.default)
  'rgb-accent-primary': '250 255 105', // #faff69 (accent.default)
  'rgb-accent-primary-hover': '253 255 163', // #fdffa3 (palette.brand.200)

  // Ring colors
  'rgb-ring-primary': '250 255 105', // #faff69 (outline.default)
  'rgb-focus-outline': '250 255 105', // #faff69 (outline.default)
  'rgb-focus-control': '250 255 105', // #faff69 (outline.default)

  // Header colors
  'rgb-header-primary': '31 31 28', // #1f1f1c (background.default)
  'rgb-header-hover': '40 40 40', // #282828 (background.muted)
  'rgb-header-button-hover': '40 40 40', // #282828 (background.muted)

  // Surface colors
  'rgb-surface-active': '65 65 65', // #414141 (palette.neutral.700)
  'rgb-surface-active-alt': '50 50 50', // #323232 (palette.neutral.712)
  'rgb-surface-hover': '50 50 50', // #323232 (palette.neutral.712)
  'rgb-surface-hover-alt': '65 65 65', // #414141 (palette.neutral.700)
  'rgb-surface-pressed': '36 36 36', // #242424 (button.iconButton.color.primary.background.active)
  'rgb-surface-composer-hover': '50 50 50', // #323232 (palette.neutral.712)
  'rgb-surface-primary': '31 31 28', // #1f1f1c (background.default)
  'rgb-chart-widget-surface': '40 40 40', // #282828 (background.muted)
  'rgb-chart-widget-stroke': '50 50 50', // #323232 (stroke.default)
  'rgb-surface-primary-alt': '40 40 40', // #282828 (background.split)
  'rgb-surface-primary-contrast': '50 50 50', // #323232 (palette.neutral.712)
  'rgb-surface-secondary': '40 40 40', // #282828 (background.muted)
  'rgb-surface-secondary-alt': '50 50 50', // #323232 (palette.neutral.712)
  'rgb-surface-tertiary': '40 40 40', // #282828 (background.muted)
  'rgb-surface-tertiary-alt': '50 50 50', // #323232 (palette.neutral.712)
  'rgb-surface-dialog': '31 31 28', // #1f1f1c (background.default)
  'rgb-dialog-title': '249 249 249', // #f9f9f9 (dialog.color.title.default, rgb(97.5% 97.5% 97.5%))
  /** Not a Click UI value. Its dark scrim, dialog.color.opaqueBackground lch(40.731 0 none), is a
   *  #606060 gray that lifts the page instead of dimming it. A bundled scrim never lifts the page
   *  (`semanticTokens.spec.ts`), so black keeps the dark scrim; the 0.75 alpha is Click UI's. */
  'rgb-surface-overlay': '0 0 0', // #000000
  'rgb-surface-media-overlay': '0 0 0', // #000000 (no Click UI media scrim)
  'rgb-text-on-media': '255 255 255', // #ffffff (palette.neutral.0)
  'rgb-surface-submit': '250 255 105', // #faff69 (accent.default)
  'rgb-surface-submit-hover': '253 255 163', // #fdffa3 (palette.brand.200)
  'rgb-surface-destructive': '255 117 117', // #ff7575 (palette.danger.300)
  'rgb-surface-destructive-hover': '255 152 152', // #ff9898 (palette.danger.200)
  'rgb-surface-chat': '31 31 28', // #1f1f1c (background.default)
  'rgb-surface-code': '40 40 40', // #282828 (codeblock.darkMode.color.background.default)
  'rgb-surface-code-body': '40 40 40', // #282828 (codeblock.darkMode.color.background.default)
  'rgb-surface-qr': '255 255 255', // #ffffff (palette.neutral.0)
  'rgb-surface-inverted': '250 255 105', // #faff69 (button.basic.color.primary.background.default)
  'rgb-surface-inverted-hover': '252 255 150', // #fcff96 (button.basic.color.primary.background.hover)
  'rgb-surface-inverted-pressed': '231 236 97', // #e7ec61 (button.basic.color.primary.background.active)
  'rgb-button-primary': '250 255 105', // #faff69 (button.basic.color.primary.background.default)
  'rgb-button-primary-hover': '252 255 150', // #fcff96 (button.basic.color.primary.background.hover)
  'rgb-text-inverted': '31 31 28', // #1f1f1c (button.basic.color.primary.text.default)
  'rgb-surface-fixed': '255 255 255', // #ffffff (palette.neutral.0, same in light and dark)
  'rgb-surface-fixed-hover': '230 231 233', // #e6e7e9 (palette.slate.100, same in light and dark)
  'rgb-text-fixed': '22 21 23', // #161517 (palette.slate.900, same in light and dark)

  // Border colors
  'rgb-border-light': '50 50 50', // #323232 (stroke.default)
  'rgb-border-medium': '50 50 50', // #323232 (stroke.default)
  'rgb-border-medium-alt': '50 50 50', // #323232 (stroke.default)
  'rgb-border-heavy': '65 65 65', // #414141 (stroke.intense)
  'rgb-drawer-edge': '128 128 128', // #808080 (palette.neutral.500, matching border-xheavy)
  'rgb-border-xheavy': '128 128 128', // #808080 (palette.neutral.500, three steps past stroke.intense #414141 (1.62:1 on the canvas))
  'rgb-border-destructive': '255 117 117', // #ff7575 (palette.danger.300)
  'rgb-border-control': '128 128 128', // #808080 (palette.neutral.500, 3.73:1 on background.muted)
  'rgb-border-field-focus': '250 255 105', // #faff69 (field.color.stroke.active)
  'rgb-field-fill': '45 45 45', // rgb(17.794% 17.794% 17.794%) (field.color.background.default)
  'rgb-field-text': '230 231 233', // #e6e7e9 (field.color.text.default)
  'rgb-surface-disabled': '65 65 65', // #414141 (button.basic.color.primary.background.disabled)
  'rgb-text-disabled': '128 128 128', // #808080 (text.disabled)
  'rgb-border-disabled': '65 65 65', // #414141 (field.color.stroke.disabled)

  // Status colors
  'rgb-status-success': '204 255 208', // #ccffd0 (feedback.success.foreground)
  'rgb-status-success-subtle': '0 66 6', // #004206 (feedback.success.background)
  'rgb-status-success-border': '0 97 8', // #006108 (palette.success.800)
  'rgb-status-success-strong': '0 229 19', // #00e513 (palette.success.500)
  'rgb-status-info': '208 223 251', // #d0dffb (feedback.info.foreground)
  'rgb-status-info-subtle': '13 62 155', // #0d3e9b (feedback.info.background)
  'rgb-status-info-border': '16 78 198', // #104ec6 (palette.info.600)
  'rgb-status-info-strong': '109 155 243', // #6d9bf3 (palette.info.300)
  'rgb-status-warning': '255 184 143', // #ffb88f (feedback.warning.foreground)
  'rgb-status-warning-subtle': '122 45 0', // #7a2d00 (feedback.warning.background)
  'rgb-status-warning-border': '163 60 0', // #a33c00 (palette.warning.700)
  'rgb-status-warning-strong': '255 148 87', // #ff9457 (palette.warning.300)
  'rgb-status-error': '255 186 186', // #ffbaba (feedback.danger.foreground)
  'rgb-status-error-subtle': '97 0 0', // #610000 (feedback.danger.background)
  'rgb-status-error-border': '145 0 0', // #910000 (palette.danger.700)
  'rgb-status-error-strong': '255 117 117', // #ff7575 (palette.danger.300)
  'rgb-status-neutral': '249 249 249', // #f9f9f9 (feedback.neutral.foreground)
  'rgb-status-neutral-subtle': '65 65 65', // #414141 (feedback.neutral.background)
  'rgb-status-neutral-border': '50 50 50', // #323232 (feedback.neutral.stroke)
  'rgb-status-verified': '109 155 243', // #6d9bf3 (palette.info.300, matching status-info-strong)
  'rgb-text-on-status': '29 29 29', // #1d1d1d (iconButton.badge.foreground, the label Click UI sets on its yellow)

  // Brand colors
  'rgb-brand-purple': '204 102 255', // #cc66ff (palette.violet.300)
  'rgb-avatar-fill': '128 134 145', // #808691 (avatar.color.background.default)
  'rgb-avatar-text': '31 31 28', // #1f1f1c (avatar.color.text.default)
  'rgb-avatar-placeholder': '40 40 40', // #282828 (background.muted)
  'rgb-avatar-edge': '240 246 252', // #f0f6fc (Click UI avatars draw no edge)
  'rgb-illustration-subtle': '161 190 247', // #a1bef7 (palette.info.200)
  'rgb-illustration': '67 126 239', // #437eef (palette.info.400)
  'rgb-illustration-strong': '16 78 198', // #104ec6 (palette.info.600)
  'rgb-file-document': '204 0 153', // #cc0099 (palette.fuchsia.600)
  'rgb-file-sheet': '0 138 11', // #008a0b (palette.success.700)
  'rgb-file-code': '214 79 0', // #d64f00 (palette.warning.600)
  'rgb-file-artifact': '48 46 50', // #302e32 (palette.slate.800)
  'rgb-file-audio': '138 105 0', // #8a6900 (palette.sunrise.700)
  'rgb-file-video': '136 0 204', // #8800cc (palette.violet.600)
  'rgb-file-generic': '16 78 198', // #104ec6 (palette.info.600)
  'rgb-file-ink': '255 255 255', // #ffffff (palette.neutral.0)

  // Code syntax
  'rgb-syntax-text': '255 255 255', // #ffffff (codeblock.darkMode.color.text.default)
  'rgb-syntax-comment': '179 182 189', // #b3b6bd (text.muted)
  'rgb-syntax-meta': '154 158 167', // #9a9ea7 (palette.slate.400)
  'rgb-syntax-builtin': '255 195 0', // #ffc300 (chart.default.sunrise)
  'rgb-syntax-keyword': '109 155 243', // #6d9bf3 (palette.info.300)
  'rgb-syntax-string': '102 255 115', // #66ff73 (palette.success.300)
  'rgb-syntax-attr': '251 100 214', // #fb64d6 (chart.default.fuchsia)
  'rgb-syntax-title': '255 119 41', // #ff7729 (chart.default.orange)

  // Series
  'rgb-series-1': '67 126 239', // #437eef (chart.default.blue)
  'rgb-series-2': '255 119 41', // #ff7729 (chart.default.orange)
  'rgb-series-3': '51 255 68', // #33ff44 (chart.default.green)
  'rgb-series-4': '251 100 214', // #fb64d6 (chart.default.fuchsia)
  'rgb-series-5': '255 195 0', // #ffc300 (chart.default.sunrise)
  'rgb-series-6': '187 51 255', // #bb33ff (chart.default.violet)
  'rgb-series-7': '0 203 235', // #00cbeb (chart.default.babyblue)
  'rgb-series-8': '109 248 225', // #6df8e1 (chart.default.teal)

  // Switch
  'rgb-switch-unchecked': '128 128 128', // #808080 (palette.neutral.500)
  'rgb-switch-thumb': '21 21 21', // #151515 (switch.color.indicator.default)

  // Table
  'rgb-table-header-text': '249 249 249', // #f9f9f9 (table.header.color.title.default, rgb(97.5% 97.5% 97.5%))
  'rgb-table-header-fill': '40 40 40', // #282828 (table.header.color.background.default)

  // Presentation
  'rgb-presentation': '31 31 28', // #1f1f1c (background.default)
};

/**
 * Click UI's shape, from `border.radii`, `typography.font.families` and `shadow`.
 *
 * Nearly every Click UI component (button, field, card, menu, popover, table, toast) is drawn at
 * `radii.1`, and the dialog at `radii.2`, so the small and medium steps collapse onto `radii.1`,
 * the dialog-sized steps onto `radii.2`, and the largest onto `radii.3`. `rounded-sm` takes
 * `radii.1`, which LibreChat's `sm` also renders at on a 16px root; every larger step tightens.
 *
 * Click UI's mono family is Inconsolata, which the component library ships in `theme/fonts.css`
 * (latin 400 and 700), and the stack is Click UI's verbatim. Its `"SFMono Regular"` matches no
 * installed face, so where Inconsolata has no glyph a browser falls to Consolas or `monospace`.
 *
 * Click UI's display family leads with Basier Square, a commercial face ClickHouse licenses for
 * its own sites. It is named here but not self-hosted: a browser that has it installed renders
 * headings in it, and every other one falls through to the same Inter stack as the body. The
 * `text-*` scale takes Click UI's `font.sizes` 1 to 5 at its product line height of 1.5. Click UI
 * has no step between 1.25rem and 2rem, and 2rem would overtake Tailwind's unthemed `text-3xl`
 * (1.875rem), so `2xl` keeps LibreChat's 1.5rem at Click UI's line height.
 *
 * Click UI raises every elevated surface (card, dialog, menu, panel, popover, toast) with
 * `shadow.1`, and its only lighter step is the hairline `shadow.5`. Steps 2 to 4 are the flyout's
 * inset and directional edges, which do not belong on a general scale. `shadow.1` darkens from
 * 0.15 to 0.6 alpha in dark mode; its colour is `#151515` in both (written `lch(6.7738 0 none)`
 * in the light tokens and as percentages in the dark).
 */
const clickHouseShape = {
  controlRadius: '0.25rem',
  surfaceRadius: '0.5rem',
  largeSurfaceRadius: '0.75rem',
  roundControlRadius: '9999px',
  menuRadius: '0.25rem', // genericMenu.panel.radii.all
  tooltipRadius: '0.25rem', // tooltip.radii.all
  tabRadius: '0.25rem', // tabs.radii.all
  /** Click UI sizes a tab trigger by its label, in `tabs.space.x` on each side. */
  tabMinWidth: '0',
  radiusSm: '0.25rem', // border.radii.1
  radiusMd: '0.25rem', // border.radii.1
  radiusLg: '0.25rem', // border.radii.1
  radiusXl: '0.5rem', // border.radii.2
  radius2xl: '0.5rem', // border.radii.2
  radius3xl: '0.75rem', // border.radii.3
  fontFamily:
    '"Inter", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif',
  monoFontFamily: '"Inconsolata", Consolas, "SFMono Regular", monospace', // typography.font.families.mono
  displayFontFamily:
    '\'Basier Square\', "Inter", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif', // typography.font.families.display
  textXs: '0.75rem', // typography.font.sizes.1
  textSm: '0.875rem', // typography.font.sizes.2
  textBase: '1rem', // typography.font.sizes.3
  textLg: '1.125rem', // typography.font.sizes.4
  textXl: '1.25rem', // typography.font.sizes.5
  text2xl: '1.5rem', // LibreChat's: Click UI's next step (sizes.6, 2rem) passes the unthemed text-3xl
  leadingXs: '1.5', // typography.font.line-height.1
  leadingSm: '1.5', // typography.font.line-height.1
  leadingBase: '1.5', // typography.font.line-height.1
  leadingLg: '1.5', // typography.font.line-height.1
  leadingXl: '1.5', // typography.font.line-height.1
  leading2xl: '1.5', // typography.font.line-height.1
  shadow2xs: '0 2px 2px 0 rgb(0 0 0 / 0.03)', // shadow.5
  shadowXs: '0 2px 2px 0 rgb(0 0 0 / 0.03)', // shadow.5
  shadowSm: '0 2px 2px 0 rgb(0 0 0 / 0.03)', // shadow.5
  controlHeight: '2rem', // genericMenu.panel.size.height
  controlPaddingX: '1rem', // button.basic.space.x
  controlGap: '0.5rem', // button.basic.space.gap
  controlFontWeight: '400', // button.basic.typography.label.default
  /** Click UI's button is sized by its content: 0.2813rem of space.y on both sides of a
   *  0.875rem/1.5 label and a 1px stroke, 32px in all. */
  buttonHeight: '2rem',
  buttonHeightSm: '2rem',
  /** Click UI draws one button size, so the `lg` step matches the default too. Its icon button is
   *  a 1rem icon in 0.25rem of `iconButton.sm` space on each side, 1.5rem in all, which still meets
   *  the 24px target minimum; its `xs` (no space) would not, so `icon-xs` keeps LibreChat's. */
  buttonHeightLg: '2rem',
  buttonHeightCompact: '2rem',
  iconButtonSizeSm: '1.5rem',
  iconSize: '1rem', // image.sm.size.width
  iconSizeMd: '1.25rem', // image.md.size.width
  iconSizeLg: '1.5rem', // image.lg.size.width, the dialog close icon
  /** Click UI's field is sized by its content, like its button: 0.2813rem of space.y on both
   *  sides of a 0.875rem/1.5 value and a 1px stroke, 32px in all. On focus it swaps its stroke to
   *  `field.color.stroke.active` and draws no ring (InputWrapper); LibreChat adds a 1px ring in
   *  that color on keyboard focus only, to keep its 2px focus floor. */
  fieldHeight: '2rem',
  fieldPaddingY: '0.2813rem', // field.space.y
  fieldFocusStyle: 'border' as const,
  /** Click UI fills its fields in `field.color.background.default`. */
  fieldFillStyle: 'fill' as const,
  /** Click UI's keyboard focus outline: 2px in `outline.default`, 2px off the edge
   *  (BaseButton.module.css, IconButton, Dropdown and ContextMenu triggers). */
  focusRingWidth: '2px',
  focusRingOffset: '2px',
  /** `field.typography.label.default`: 500 0.75rem/1.5. */
  labelSize: '0.75rem',
  labelLeading: '1.5',
  labelFontWeight: '500',
  dialogStroke: '1px', // dialog.stroke.default, in stroke.default (border-light)
  dialogPaddingX: '2rem', // dialog.space.x; its space.y is LibreChat's 1.5rem
  dialogHeaderGap: '0.25rem', // dialog.title.space.gap
  /** `dialog.typography.title.default`: 700 1.25rem/1.5 in the regular family, not the display
   *  one Click UI keeps for page titles. */
  dialogTitleSize: '1.25rem',
  dialogTitleLeading: '1.5',
  dialogTitleFontWeight: '700',
  dialogTitleFontFamily:
    '"Inter", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif',
  scrimOpacity: '0.75', // dialog.color.opaqueBackground alpha
  alertScrimOpacity: '0.75', // dialog.color.opaqueBackground alpha
  modalScrimOpacity: '0.75', // dialog.color.opaqueBackground alpha
  /** Click UI paints disabled controls in fixed fills (`#dfdfdf` / `#414141`) rather than fading them. */
  disabledStyle: 'fill' as const,
  switchWidth: '2rem', // switch.size.width
  switchHeight: '1rem', // switch.size.height
  checkboxSize: '1rem', // checkbox.size.all
  /** Click UI's own sizes halve like LibreChat's: `md` is this full space, and the compact tables
   *  every in-repo consumer draws land on `sm` (0.5rem), the size Click UI tables default to. */
  /** The shared spacing takes two steps of Click UI's `spaces` scale: its 0.5rem gap step, the
   *  one its buttons and fields space icon and label by, and 0.75rem, which already matched. */
  spaceCompact: '0.5rem', // spaces.2
  spaceNormal: '0.75rem', // spaces.3
  tableCellSpaceY: '1rem', // table.body.cell.space.md.y
  tableRowStroke: '1px', // table.cell.stroke
  motionFast: '100ms', // transition.duration.medium, the step transition.default runs at
  motionNormal: '150ms', // transition.duration.smooth
};

const elevation = (alpha: number): string =>
  `0 4px 6px -1px rgb(21 21 21 / ${alpha}), 0 2px 4px -1px rgb(21 21 21 / ${alpha})`;

const clickHouseElevation = (alpha: number): Partial<IThemeAppearance> => ({
  shadowMd: elevation(alpha), // shadow.1
  shadowLg: elevation(alpha), // shadow.1
  shadowXl: elevation(alpha), // shadow.1
  shadow2xl: elevation(alpha), // shadow.1
  elevationSurface: elevation(alpha), // shadow.1
  menuShadow: elevation(alpha), // genericMenu.panel.shadow.default, which is shadow.1
  /** Click UI's tooltip draws no shadow (Tooltip.module.css). */
  tooltipShadow: 'none',
  elevationDrag: elevation(alpha), // shadow.1
});

const clickHouseLightAppearance: Partial<IThemeAppearance> = {
  ...clickHouseShape,
  ...clickHouseElevation(0.15),
};

const clickHouseDarkAppearance: Partial<IThemeAppearance> = {
  ...clickHouseShape,
  ...clickHouseElevation(0.6),
};

export const clickHouseTheme: ThemeDefinition = Object.freeze({
  version: 1,
  name: 'clickhouse',
  modes: {
    light: { colors: clickHouseLightTheme, appearance: clickHouseLightAppearance },
    dark: { colors: clickHouseDarkTheme, appearance: clickHouseDarkAppearance },
  },
});

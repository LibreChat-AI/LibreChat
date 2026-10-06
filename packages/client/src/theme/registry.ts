import {
  THEME_VERSION,
  isThemeRGB,
  collectThemeIssues,
  isThemeAppearanceToken,
  collectThemeWarningIssues,
  defaultSwitchSize,
  themeColorTokens as sharedColorTokens,
  themeBrandTokens as sharedBrandTokens,
} from 'librechat-data-provider';
import type {
  ThemeColorToken,
  ThemeBrandToken,
  ThemeAppearanceToken,
} from 'librechat-data-provider';
import type {
  IThemeAppearance,
  IThemeBrands,
  IThemeColors,
  IThemeVariables,
  IThemeRGB,
  ResolvedThemeDefinition,
  ThemeDefinition,
  ThemeMode,
} from './types';
import { highContrastDarkTheme, highContrastLightTheme } from './themes/highContrast';
import { defaultTheme } from './themes/default';
import { darkTheme } from './themes/dark';

export { THEME_VERSION };

/**
 * Compile-time guard: the categorical series scale is declared across three
 * hand-maintained token maps, so a slot added to one and missed in another
 * fails the build rather than surfacing as a broken theme downstream.
 */
type SeriesSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
type Assert<Declared extends true> = Declared;
type DeclaredIn<Keys extends PropertyKey, Tokens> = [Keys] extends [keyof Tokens] ? true : false;

export type SeriesTokensAreDeclared = [
  Assert<DeclaredIn<`rgb-series-${SeriesSlot}`, IThemeRGB>>,
  Assert<DeclaredIn<`--series-${SeriesSlot}`, IThemeVariables>>,
  Assert<DeclaredIn<`series-${SeriesSlot}`, IThemeColors>>,
];

type SameKeys<A extends PropertyKey, B extends PropertyKey> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

/** The token lists live in `librechat-data-provider` so the server validates against the same
 *  set; these fail the build when the client types drift from them. */
export type SharedTokensMatchTypes = [
  Assert<SameKeys<ThemeColorToken, keyof IThemeRGB>>,
  Assert<SameKeys<ThemeAppearanceToken, keyof IThemeAppearance>>,
  Assert<SameKeys<ThemeBrandToken, keyof IThemeBrands>>,
];

export const themeColorTokens: readonly (keyof IThemeRGB)[] = sharedColorTokens;

const colorTokenSet: ReadonlySet<string> = new Set<string>(themeColorTokens);

/**
 * What the verified mark is measured against: the fill it wore before it had a
 * token, the check it carries, and the backgrounds `ToolCard` takes at rest and
 * on hover. A theme naming any of these coordinated the mark; one naming none
 * of them never looked at it.
 */
export const MARK_NEIGHBOURHOOD: readonly (keyof IThemeRGB)[] = Object.freeze([
  'rgb-status-success-strong',
  'rgb-text-on-status',
  'rgb-surface-dialog',
  'rgb-surface-secondary',
  'rgb-surface-tertiary',
]);

/**
 * The control outline for a stored or environment theme that predates
 * `rgb-border-control`. Fields, dropdowns and comboboxes drew `border-light`
 * and selects and OTP slots drew `border-medium` before the role existed, so a
 * theme that painted either keeps that edge on its controls, the light border
 * first. A theme that painted neither keeps the bundled role, and one that
 * names the role keeps it as written.
 */
export function controlBorderFallback(colors: IThemeRGB): string | undefined {
  if (colors['rgb-border-control'] !== undefined) {
    return undefined;
  }
  return colors['rgb-border-light'] ?? colors['rgb-border-medium'];
}

/**
 * The pressed fills for a theme that predates them. A pointer press lands on a
 * hovered control, so the press showed the hover fill; a theme that painted a
 * hover keeps it for the press, and one that names a pressed fill keeps it.
 */
export function pressedFallbacks(colors: IThemeRGB): IThemeRGB {
  const pressed = colors['rgb-surface-pressed'] ?? colors['rgb-surface-hover'];
  const inverted = colors['rgb-surface-inverted-pressed'] ?? colors['rgb-surface-inverted-hover'];
  return {
    ...(pressed !== undefined ? { 'rgb-surface-pressed': pressed } : {}),
    ...(inverted !== undefined ? { 'rgb-surface-inverted-pressed': inverted } : {}),
  };
}

/**
 * The Button's primary fills for a theme that predates them. The Button was painted in the
 * inverted surface, so a theme that repaints that surface or its hover keeps its buttons on it.
 */
export function primaryButtonFallbacks(colors: IThemeRGB): IThemeRGB {
  const fill = colors['rgb-button-primary'] ?? colors['rgb-surface-inverted'];
  const hover = colors['rgb-button-primary-hover'] ?? colors['rgb-surface-inverted-hover'];
  return {
    ...(fill !== undefined ? { 'rgb-button-primary': fill } : {}),
    ...(hover !== undefined ? { 'rgb-button-primary-hover': hover } : {}),
  };
}

/**
 * Layering roles split out of the surface a component painted before each had a name: the role,
 * and the surface it followed in light and in dark. A theme that repaints the surface keeps the
 * layer on it, unless it names the role.
 */
export const layerRoleSources: ReadonlyArray<
  readonly [keyof IThemeRGB, keyof IThemeRGB, keyof IThemeRGB]
> = [
  ['rgb-surface-canvas', 'rgb-surface-primary-alt', 'rgb-surface-primary-alt'],
  ['rgb-surface-user-message', 'rgb-surface-tertiary', 'rgb-surface-tertiary'],
  ['rgb-surface-card', 'rgb-surface-secondary', 'rgb-surface-secondary'],
  ['rgb-surface-card-hover', 'rgb-surface-tertiary', 'rgb-surface-tertiary'],
  ['rgb-surface-nav-hover', 'rgb-surface-active-alt', 'rgb-surface-active-alt'],
  ['rgb-surface-nav-selected', 'rgb-surface-active-alt', 'rgb-surface-active-alt'],
  ['rgb-surface-tab-selected', 'rgb-surface-tertiary', 'rgb-surface-tertiary'],
  ['rgb-surface-menu', 'rgb-presentation', 'rgb-presentation'],
  ['rgb-surface-popover', 'rgb-surface-primary', 'rgb-surface-secondary'],
  ['rgb-border-menu', 'rgb-border-light', 'rgb-border-light'],
  ['rgb-surface-composer', 'rgb-surface-chat', 'rgb-surface-chat'],
  ['rgb-surface-search', 'rgb-surface-secondary', 'rgb-surface-secondary'],
];

export function layerRoleFallbacks(colors: IThemeRGB, mode: ThemeMode): IThemeRGB {
  return Object.fromEntries(
    layerRoleSources.flatMap(([role, light, dark]) => {
      const source = colors[mode === 'dark' ? dark : light];
      return colors[role] === undefined && source !== undefined ? [[role, source]] : [];
    }),
  );
}

/** Inks split out of the primary one: dialog titles, badge labels, the default avatar's glyph and
 *  a field's typed value were all set in it. */
export const primaryInkRoles: ReadonlyArray<keyof IThemeRGB> = [
  'rgb-dialog-title',
  'rgb-badge-label',
  'rgb-avatar-text',
  'rgb-field-text',
];

/** A theme that repaints the primary ink keeps the inks split out of it on it, unless it names them. */
export function primaryInkFallbacks(colors: IThemeRGB): IThemeRGB {
  const primary = colors['rgb-text-primary'];
  return Object.fromEntries(
    primaryInkRoles.flatMap((role) => {
      const ink = colors[role] ?? primary;
      return ink === undefined ? [] : [[role, ink]];
    }),
  );
}

/** Roles that were painted in another role before they had their own. */
export const overlayFallbackSources: ReadonlyArray<readonly [keyof IThemeRGB, keyof IThemeRGB]> = [
  ['rgb-surface-tooltip', 'rgb-surface-primary'],
  ['rgb-text-tooltip', 'rgb-text-primary'],
  ['rgb-alert-error-fill', 'rgb-status-error-subtle'],
  ['rgb-alert-error-border', 'rgb-status-error-border'],
];

/** A theme that repaints a source role keeps the tooltip and the error alert on it, unless it
 *  names them. */
export function overlayFallbacks(colors: IThemeRGB): IThemeRGB {
  return Object.fromEntries(
    overlayFallbackSources.flatMap(([role, source]) => {
      const value = colors[source];
      return colors[role] === undefined && value !== undefined ? [[role, value]] : [];
    }),
  );
}

/**
 * The focus roles for a stored or environment theme that predates them. The
 * global outline followed a theme's `rgb-ring-primary` whenever it named one,
 * and the shared primitives drew their ring in `rgb-text-primary`, so a theme
 * that painted either keeps that focus color. A theme that painted neither
 * keeps the bundled roles, and one that names a role keeps it as written.
 */
export function focusFallbacks(colors: IThemeRGB): IThemeRGB {
  const outline = colors['rgb-focus-outline'] ?? colors['rgb-ring-primary'];
  const control = colors['rgb-focus-control'] ?? colors['rgb-text-primary'];
  const field = colors['rgb-border-field-focus'] ?? control;
  return {
    ...(outline !== undefined ? { 'rgb-focus-outline': outline } : {}),
    ...(control !== undefined ? { 'rgb-focus-control': control } : {}),
    ...(field !== undefined ? { 'rgb-border-field-focus': field } : {}),
  };
}

export const themeAppearanceProperties: Readonly<
  Record<keyof IThemeAppearance, `--theme-${string}`>
> = Object.freeze({
  controlRadius: '--theme-control-radius',
  roundControlRadius: '--theme-round-control-radius',
  surfaceRadius: '--theme-surface-radius',
  largeSurfaceRadius: '--theme-large-surface-radius',
  menuRadius: '--theme-menu-radius',
  popoverRadius: '--theme-popover-radius',
  menuPanelRadius: '--theme-menu-panel-radius',
  composerActionRadius: '--theme-composer-action-radius',
  inlineCodeWeight: '--theme-inline-code-weight',
  tooltipRadius: '--theme-tooltip-radius',
  tooltipPaddingX: '--theme-tooltip-padding-x',
  tooltipPaddingY: '--theme-tooltip-padding-y',
  tooltipTextSize: '--theme-tooltip-text-size',
  tabRadius: '--theme-tab-radius',
  tabMinWidth: '--theme-tab-min-width',
  listMinWidth: '--theme-list-min-width',
  listMaxHeight: '--theme-list-max-height',
  radiusSm: '--theme-radius-sm',
  radiusMd: '--theme-radius-md',
  radiusLg: '--theme-radius-lg',
  radiusXl: '--theme-radius-xl',
  radius2xl: '--theme-radius-2xl',
  radius3xl: '--theme-radius-3xl',
  controlHeight: '--theme-control-height',
  controlPaddingX: '--theme-control-padding-x',
  controlGap: '--theme-control-gap',
  iconSize: '--theme-icon-size',
  iconSizeMd: '--theme-icon-size-md',
  iconSizeLg: '--theme-icon-size-lg',
  controlFontWeight: '--theme-control-font-weight',
  buttonHeight: '--theme-button-height',
  buttonHeightSm: '--theme-button-height-sm',
  buttonHeightXs: '--theme-button-height-xs',
  buttonHeightLg: '--theme-button-height-lg',
  buttonHeightCompact: '--theme-button-height-compact',
  iconButtonSizeSm: '--theme-icon-button-size-sm',
  fieldHeight: '--theme-field-height',
  fieldHeightLg: '--theme-field-height-lg',
  fieldPaddingY: '--theme-field-padding-y',
  fieldFocusStyle: '--theme-field-focus-style',
  fieldFillStyle: '--theme-field-fill-style',
  focusRingWidth: '--theme-focus-ring-width',
  focusRingOffset: '--theme-focus-ring-offset',
  labelSize: '--theme-label-size',
  labelLeading: '--theme-label-leading',
  labelFontWeight: '--theme-label-font-weight',
  switchWidth: '--theme-switch-width',
  switchHeight: '--theme-switch-height',
  checkboxSize: '--theme-checkbox-size',
  tableCellSpaceY: '--theme-table-cell-space-y',
  tableRowStroke: '--theme-table-row-stroke',
  spaceCompact: '--theme-space-compact',
  spaceNormal: '--theme-space-normal',
  disabledStyle: '--theme-disabled-style',
  fontFamily: '--theme-font-family',
  monoFontFamily: '--theme-mono-font-family',
  displayFontFamily: '--theme-display-font-family',
  textXs: '--theme-text-xs',
  textSm: '--theme-text-sm',
  textBase: '--theme-text-base',
  textLg: '--theme-text-lg',
  textXl: '--theme-text-xl',
  text2xl: '--theme-text-2xl',
  text3xs: '--theme-text-3xs',
  text2xs: '--theme-text-2xs',
  textXsPlus: '--theme-text-xs-plus',
  textSmPlus: '--theme-text-sm-plus',
  leadingXs: '--theme-text-xs-leading',
  leadingSm: '--theme-text-sm-leading',
  leadingBase: '--theme-text-base-leading',
  leadingLg: '--theme-text-lg-leading',
  leadingXl: '--theme-text-xl-leading',
  leading2xl: '--theme-text-2xl-leading',
  dialogStroke: '--theme-dialog-stroke',
  dialogPaddingX: '--theme-dialog-padding-x',
  dialogHeaderGap: '--theme-dialog-header-gap',
  dialogTitleSize: '--theme-dialog-title-size',
  dialogTitleLeading: '--theme-dialog-title-leading',
  dialogTitleFontWeight: '--theme-dialog-title-font-weight',
  dialogTitleFontFamily: '--theme-dialog-title-font-family',
  scrimOpacity: '--theme-scrim-opacity',
  alertScrimOpacity: '--theme-alert-scrim-opacity',
  modalScrimOpacity: '--theme-modal-scrim-opacity',
  elevationSurface: '--theme-elevation-surface',
  elevationDrag: '--theme-elevation-drag',
  shadow2xs: '--theme-shadow-2xs',
  shadowXs: '--theme-shadow-xs',
  shadowSm: '--theme-shadow-sm',
  shadowMd: '--theme-shadow-md',
  shadowLg: '--theme-shadow-lg',
  shadowXl: '--theme-shadow-xl',
  shadow2xl: '--theme-shadow-2xl',
  menuShadow: '--theme-menu-shadow',
  tooltipShadow: '--theme-tooltip-shadow',
  motionFast: '--theme-motion-fast',
  motionNormal: '--theme-motion-normal',
  chromeBorderAlpha: '--theme-border-chrome-alpha',
  insetBorderAlpha: '--theme-border-inset-alpha',
  destructiveStyle: '--theme-destructive-style',
});

export const defaultAppearance: IThemeAppearance = Object.freeze({
  controlRadius: '0.75rem',
  roundControlRadius: '9999px',
  surfaceRadius: '1rem',
  largeSurfaceRadius: '1.5rem',
  menuRadius: '0.7rem',
  popoverRadius: '1rem',
  menuPanelRadius: '0.75rem',
  composerActionRadius: '9999px',
  inlineCodeWeight: '600',
  tooltipRadius: '0.275rem',
  tooltipPaddingX: '0.5rem',
  tooltipPaddingY: '0.25rem',
  tooltipTextSize: '1rem',
  tabRadius: '0.185rem',
  tabMinWidth: '100px',
  listMinWidth: '8rem',
  listMaxHeight: '24rem',
  radiusSm: 'calc(0.5rem - 4px)',
  radiusMd: 'calc(0.5rem - 2px)',
  radiusLg: '0.5rem',
  radiusXl: '0.75rem',
  radius2xl: '1rem',
  radius3xl: '1.5rem',
  controlHeight: '2.25rem',
  controlPaddingX: '0.75rem',
  controlGap: '0.375rem',
  iconSize: '1rem',
  iconSizeMd: '1.25rem',
  iconSizeLg: '1.5rem',
  controlFontWeight: '500',
  buttonHeight: '2.5rem',
  buttonHeightSm: '2.25rem',
  buttonHeightXs: '1.75rem',
  buttonHeightLg: '2.75rem',
  buttonHeightCompact: '2rem',
  iconButtonSizeSm: '2rem',
  fieldHeight: '2.5rem',
  fieldHeightLg: '3rem',
  fieldPaddingY: '0.5rem',
  fieldFocusStyle: 'ring',
  fieldFillStyle: 'transparent',
  focusRingWidth: '2px',
  focusRingOffset: '2px',
  labelSize: '0.875rem',
  labelLeading: '1',
  labelFontWeight: 'inherit',
  ...defaultSwitchSize,
  checkboxSize: '1rem',
  tableCellSpaceY: '1rem',
  tableRowStroke: '0px',
  spaceCompact: '0.375rem',
  spaceNormal: '0.75rem',
  disabledStyle: 'dim',
  fontFamily: 'Inter, sans-serif',
  monoFontFamily:
    "'Roboto Mono', ui-monospace, SFMono-Regular, Menlo, 'Cascadia Mono', 'Liberation Mono', Consolas, monospace",
  displayFontFamily: 'Inter, sans-serif',
  textXs: '0.75rem',
  textSm: '0.875rem',
  textBase: '1rem',
  textLg: '1.125rem',
  textXl: '1.25rem',
  text2xl: '1.5rem',
  text3xs: '0.625rem',
  text2xs: '0.6875rem',
  textXsPlus: '0.8125rem',
  textSmPlus: '0.9375rem',
  leadingXs: 'calc(1 / 0.75)',
  leadingSm: 'calc(1.25 / 0.875)',
  leadingBase: 'calc(1.5 / 1)',
  leadingLg: 'calc(1.75 / 1.125)',
  leadingXl: 'calc(1.75 / 1.25)',
  leading2xl: 'calc(2 / 1.5)',
  dialogStroke: '0px',
  dialogPaddingX: '1.5rem',
  dialogHeaderGap: '0.375rem',
  dialogTitleSize: '1.125rem',
  dialogTitleLeading: '1',
  dialogTitleFontWeight: '600',
  dialogTitleFontFamily: 'Inter, sans-serif',
  scrimOpacity: '0.8',
  alertScrimOpacity: '0.9',
  modalScrimOpacity: '0.65',
  elevationSurface: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  elevationDrag: '0 10px 25px rgb(0 0 0 / 0.1)',
  shadow2xs: '0 1px rgb(0 0 0 / 0.05)',
  shadowXs: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  shadowSm: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  shadowMd: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  shadowLg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  shadowXl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  shadow2xl: '0 25px 50px -12px rgb(0 0 0 / 0.25)',
  menuShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  tooltipShadow: '0 2px 4px 0 rgb(0 0 0 / 0.25)',
  motionFast: '150ms',
  motionNormal: '200ms',
  chromeBorderAlpha: '1',
  insetBorderAlpha: '1',
  destructiveStyle: 'fill',
});

/**
 * The defaults that differ in dark mode, over `defaultAppearance`. The menu panel and the tooltip
 * always drew a heavier shadow on a dark page, so their dark defaults are those literals. A theme
 * that names a role in a mode replaces the default for that mode only.
 */
export const darkAppearanceDefaults: Readonly<Partial<IThemeAppearance>> = Object.freeze({
  menuShadow: '0 10px 15px -3px rgb(0 0 0 / 0.25), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  tooltipShadow: '0 1px 2px 0 rgb(0 0 0 / 0.35)',
});

/** Every appearance default in `mode`. */
export function defaultAppearanceFor(mode: ThemeMode): IThemeAppearance {
  return mode === 'dark' ? { ...defaultAppearance, ...darkAppearanceDefaults } : defaultAppearance;
}

export const themeBrandTokens: readonly (keyof IThemeBrands)[] = sharedBrandTokens;

export const defaultBrands: IThemeBrands = Object.freeze({
  'provider-openai': '#19C37D',
  'provider-openai-gpt4': '#AB68FF',
  'provider-openai-reasoning': '#000000',
  'provider-anthropic': '#d09a74',
  'provider-azure': 'linear-gradient(0.375turn, #61bde2, #4389d0)',
  'provider-bedrock': '#268672',
  'provider-foreground': '#ffffff',
});

export const libreChatTheme: ThemeDefinition = Object.freeze({
  version: THEME_VERSION,
  name: 'librechat',
  modes: {
    light: { colors: defaultTheme },
    dark: { colors: darkTheme },
  },
  brands: defaultBrands,
});

/**
 * Built-in accessibility theme behind the `high-contrast-light` and
 * `high-contrast-dark` appearance modes. `HIGH_CONTRAST_THEME_NAME` is what
 * `applyResolvedTheme` stamps onto `data-theme`, and what the `high-contrast`
 * class on `<html>` mirrors for the CSS-only variables the token layer cannot
 * reach (see the `html.high-contrast` block in `client/src/style.css`).
 */
export const HIGH_CONTRAST_THEME_NAME = 'high-contrast' as const;

/**
 * A brand fill carries a glyph and has to stand out from the canvas, and both
 * flip between the modes, so the brands are declared per mode: dark tints under
 * a white glyph on white, bright tints under a black glyph on black. Hue is kept
 * so a provider stays recognisable; the worst pair measures 8.76:1 for both the
 * glyph and the silhouette, against 2.30:1 for the standard brand set.
 */
const highContrastLightBrands: Partial<IThemeBrands> = Object.freeze({
  'provider-openai': '#00563d',
  'provider-openai-gpt4': '#4d1a99',
  'provider-openai-reasoning': '#000000',
  'provider-anthropic': '#6b3d00',
  'provider-azure': '#00417a',
  'provider-bedrock': '#00504d',
  'provider-foreground': '#ffffff',
});

const highContrastDarkBrands: Partial<IThemeBrands> = Object.freeze({
  'provider-openai': '#7ff0b3',
  'provider-openai-gpt4': '#c8a3ff',
  'provider-openai-reasoning': '#ffffff',
  'provider-anthropic': '#ffc94d',
  'provider-azure': '#8cc8ff',
  'provider-bedrock': '#5ce6db',
  'provider-foreground': '#000000',
});

export const highContrastTheme: ThemeDefinition = Object.freeze({
  version: THEME_VERSION,
  name: HIGH_CONTRAST_THEME_NAME,
  modes: {
    light: { colors: highContrastLightTheme, brands: highContrastLightBrands },
    dark: { colors: highContrastDarkTheme, brands: highContrastDarkBrands },
  },
});

/** Tailwind composes `--tw-shadow` into one list with the ring layers, where `none` is invalid. */
const disabledShadow = '0 0 #0000';

/** The color and appearance tokens this reader does not know, which `resolveTheme` leaves out. */
export function collectThemeWarnings(theme: ThemeDefinition): string[] {
  return collectThemeWarningIssues(theme).map(({ message }) => message);
}

export function validateThemeDefinition(theme: ThemeDefinition): string[] {
  return collectThemeIssues(theme).map(({ message }) => message);
}

/**
 * A partial theme promises that an omitted value falls back, and `Partial<T>` lets a key be
 * present with `undefined`. Spreading that would overwrite the inherited value with nothing:
 * every brand and appearance token is written to the DOM unconditionally, so an avatar would
 * lose its fill and a shadow or radius step its value, unlike colors, which `mapColors` skips.
 */
function definedEntries<T extends object>(values?: Partial<T>): Partial<T> {
  if (!values) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/** A color token this reader does not know passed validation as a warning; it never reaches the DOM. */
function knownColors(colors?: IThemeRGB): IThemeRGB | undefined {
  if (!colors) {
    return colors;
  }
  return Object.fromEntries(
    Object.entries(colors).filter(([key]) => colorTokenSet.has(key)),
  ) as IThemeRGB;
}

function knownAppearance(appearance?: Partial<IThemeAppearance>): Partial<IThemeAppearance> {
  return Object.fromEntries(
    Object.entries(definedEntries(appearance)).filter(([key]) => isThemeAppearanceToken(key)),
  );
}

const shadowAppearanceKeys: ReadonlyArray<keyof IThemeAppearance> = [
  'elevationSurface',
  'elevationDrag',
  'shadow2xs',
  'shadowXs',
  'shadowSm',
  'shadowMd',
  'shadowLg',
  'shadowXl',
  'shadow2xl',
];

function withComposableShadows(appearance: IThemeAppearance): IThemeAppearance {
  return shadowAppearanceKeys.reduce<IThemeAppearance>(
    (result, key) =>
      result[key].trim().toLowerCase() === 'none' ? { ...result, [key]: disabledShadow } : result,
    appearance,
  );
}

/**
 * Roles split out of a broader one, each paired with the role it read before. Headings drew the UI
 * family before the display role existed, theme-sized controls were padded by the shared spacing,
 * and dialog titles were set in the `text-lg` step and the display family, the composer's popovers, the model selector and the send button drew `rounded-2xl`, `rounded-xl` and the round control corner, so a theme that names
 * the broader role and not the split one keeps what it drew. Pairs resolve in order, so a role can
 * follow one that is itself inherited.
 */
const inheritedAppearance: ReadonlyArray<[keyof IThemeAppearance, keyof IThemeAppearance]> = [
  ['displayFontFamily', 'fontFamily'],
  ['controlPaddingX', 'spaceNormal'],
  ['controlGap', 'spaceCompact'],
  ['labelSize', 'textSm'],
  ['dialogTitleSize', 'textLg'],
  ['dialogTitleFontFamily', 'displayFontFamily'],
  ['popoverRadius', 'radius2xl'],
  ['menuPanelRadius', 'radiusXl'],
  ['composerActionRadius', 'roundControlRadius'],
];

/**
 * Pairs that hold in one mode only. The light menu panel read `shadowLg` before it had a role, so
 * a theme that names `shadowLg` keeps shading its light menus with it; the dark panel always drew
 * its own literal, which is now its dark default.
 */
const modeInheritedAppearance: Record<
  ThemeMode,
  ReadonlyArray<[keyof IThemeAppearance, keyof IThemeAppearance]>
> = {
  light: [['menuShadow', 'shadowLg']],
  dark: [],
};

function withInheritedRoles(
  mode: ThemeMode,
  appearance?: Partial<IThemeAppearance>,
): IThemeAppearance {
  const known = knownAppearance(appearance);
  const resolved = [...inheritedAppearance, ...modeInheritedAppearance[mode]].reduce<
    Partial<IThemeAppearance>
  >(
    (roles, [role, source]) =>
      roles[role] === undefined && roles[source] !== undefined
        ? { ...roles, [role]: roles[source] }
        : roles,
    known,
  );
  return { ...defaultAppearanceFor(mode), ...resolved };
}

export function resolveTheme(theme: ThemeDefinition, mode: ThemeMode): ResolvedThemeDefinition {
  const errors = validateThemeDefinition(theme);
  if (errors.length > 0) {
    throw new TypeError(errors.join('\n'));
  }

  const baseColors = mode === 'dark' ? darkTheme : defaultTheme;
  const definition = theme.modes[mode];
  const customColors = knownColors(definition?.colors);
  /** Each fallback is typed as one `IThemeRGB`, not a `{ role } | {}` union: the colors below
   *  spread them all, and every union spread would double the type checker's work. */
  const composerHoverFallback: IThemeRGB =
    customColors?.['rgb-surface-composer-hover'] === undefined &&
    customColors?.['rgb-surface-hover'] !== undefined
      ? { 'rgb-surface-composer-hover': customColors['rgb-surface-hover'] }
      : {};
  /**
   * Code blocks are tied to the same mode-specific surfaces by the legacy CSS:
   * `surface-primary-alt` in light and `presentation` in dark. Keep that
   * relationship for themes created before `surface-code` was registered,
   * rather than pinning their syntax colours to the bundled code surface.
   */
  const codeSurfaceSource =
    mode === 'dark'
      ? customColors?.['rgb-presentation']
      : customColors?.['rgb-surface-primary-alt'];
  const codeSurfaceFallback: IThemeRGB =
    customColors?.['rgb-surface-code'] === undefined && codeSurfaceSource !== undefined
      ? { 'rgb-surface-code': codeSurfaceSource }
      : {};
  /**
   * The code pane painted `surface-chat` in light and `surface-primary-alt` in
   * dark before it had a role, so a theme that names neither pane role keeps
   * the pane it was drawn against.
   */
  const codeBodySource =
    mode === 'dark'
      ? customColors?.['rgb-surface-primary-alt']
      : customColors?.['rgb-surface-chat'];
  const codeBodyFallback: IThemeRGB =
    customColors?.['rgb-surface-code-body'] === undefined && codeBodySource !== undefined
      ? { 'rgb-surface-code-body': codeBodySource }
      : {};
  /**
   * Themes written before the shimmer stops existed cannot name them, and
   * filling the omission from the bundled base would pin their in-flight labels
   * to LibreChat's own sweep — a theme that restates its text as white would
   * light every label in the stock near-black. A theme that wants the bundled
   * sweep alongside custom text still gets it by naming the stop, the way
   * `rgb-surface-composer-hover` opts out of its own fallback above.
   */
  const shimmerBaseFallback: IThemeRGB =
    customColors?.['rgb-shimmer-base'] === undefined &&
    customColors?.['rgb-text-primary'] !== undefined
      ? { 'rgb-shimmer-base': customColors['rgb-text-primary'] }
      : {};
  const textMutedFallback: IThemeRGB =
    customColors?.['rgb-text-muted'] === undefined &&
    customColors?.['rgb-text-tertiary'] !== undefined
      ? { 'rgb-text-muted': customColors['rgb-text-tertiary'] }
      : {};
  /**
   * Markdown links read `link` in light and `text-primary` in dark before they
   * had a role, so a theme that names neither prose role keeps whichever of
   * those it painted, its own link colour first.
   */
  const proseLinkSource =
    customColors?.['rgb-link'] ??
    (mode === 'dark' ? customColors?.['rgb-text-primary'] : undefined);
  const proseLinkFallback: IThemeRGB =
    customColors?.['rgb-link-prose'] === undefined && proseLinkSource !== undefined
      ? { 'rgb-link-prose': proseLinkSource }
      : {};
  /**
   * The list marker, the blockquote bar and the inline code chip read border and surface roles
   * before they had their own, so a theme that names none of the three keeps what it painted:
   * `border-medium` for the marker, `border-light` in light and `border-medium` in dark for the
   * bar, and `surface-active-alt` in light and `surface-hover-alt` in dark for the chip.
   */
  const proseBulletSource = customColors?.['rgb-border-medium'];
  const proseQuoteBarSource = customColors?.['rgb-border-medium'];
  const codeInlineSource =
    mode === 'dark'
      ? customColors?.['rgb-surface-hover-alt']
      : customColors?.['rgb-surface-active-alt'];
  const proseFallback: IThemeRGB = {
    ...(customColors?.['rgb-prose-bullet'] === undefined && proseBulletSource !== undefined
      ? { 'rgb-prose-bullet': proseBulletSource }
      : {}),
    ...(customColors?.['rgb-prose-quote-bar'] === undefined && proseQuoteBarSource !== undefined
      ? { 'rgb-prose-quote-bar': proseQuoteBarSource }
      : {}),
    ...(customColors?.['rgb-surface-code-inline'] === undefined && codeInlineSource !== undefined
      ? { 'rgb-surface-code-inline': codeInlineSource }
      : {}),
  };
  /**
   * Agent and assistant avatars sat on `surface-secondary` in light and `surface-tertiary` in dark
   * before they had a role, so a theme that repaints the one its mode used keeps that backdrop.
   */
  const avatarPlaceholderSource =
    mode === 'dark'
      ? customColors?.['rgb-surface-tertiary']
      : customColors?.['rgb-surface-secondary'];
  const avatarPlaceholderFallback: IThemeRGB =
    customColors?.['rgb-avatar-placeholder'] === undefined && avatarPlaceholderSource !== undefined
      ? { 'rgb-avatar-placeholder': avatarPlaceholderSource }
      : {};
  /**
   * The mobile drawer drew its edge only in dark, in `border-xheavy`; in light the drawer's own
   * fill. A theme that repaints the role its mode used keeps that edge.
   */
  const drawerEdgeSource =
    mode === 'dark'
      ? customColors?.['rgb-border-xheavy']
      : customColors?.['rgb-surface-primary-alt'];
  const drawerEdgeFallback: Partial<IThemeRGB> =
    customColors?.['rgb-drawer-edge'] === undefined && drawerEdgeSource !== undefined
      ? { 'rgb-drawer-edge': drawerEdgeSource }
      : {};
  const chartWidgetSurfaceFallback: IThemeRGB =
    customColors?.['rgb-chart-widget-surface'] === undefined &&
    customColors?.['rgb-surface-primary'] !== undefined
      ? { 'rgb-chart-widget-surface': customColors['rgb-surface-primary'] }
      : {};
  /**
   * The thumb was painted `surface-primary` before it had a role, so a theme that repaints that
   * surface keeps the knob it drew against its tracks.
   */
  const switchThumbFallback: IThemeRGB =
    customColors?.['rgb-switch-thumb'] === undefined &&
    customColors?.['rgb-surface-primary'] !== undefined
      ? { 'rgb-switch-thumb': customColors['rgb-surface-primary'] }
      : {};
  /** A field fill only shows under `fieldFillStyle: 'fill'`, on the theme's own canvas by default. */
  const fieldFillFallback: IThemeRGB =
    customColors?.['rgb-field-fill'] === undefined &&
    customColors?.['rgb-surface-primary'] !== undefined
      ? { 'rgb-field-fill': customColors['rgb-surface-primary'] }
      : {};
  /** Table column names were `text-secondary` before they had a role. */
  const tableHeaderTextFallback: IThemeRGB =
    customColors?.['rgb-table-header-text'] === undefined &&
    customColors?.['rgb-text-secondary'] !== undefined
      ? { 'rgb-table-header-text': customColors['rgb-text-secondary'] }
      : {};
  /** Self-sticking table headers were the dialog surface before they had a role. */
  const tableHeaderFillFallback: IThemeRGB =
    customColors?.['rgb-table-header-fill'] === undefined &&
    customColors?.['rgb-surface-dialog'] !== undefined
      ? { 'rgb-table-header-fill': customColors['rgb-surface-dialog'] }
      : {};
  const chartWidgetStrokeFallback: IThemeRGB =
    customColors?.['rgb-chart-widget-stroke'] === undefined &&
    customColors?.['rgb-border-light'] !== undefined
      ? { 'rgb-chart-widget-stroke': customColors['rgb-border-light'] }
      : {};
  const focusSubtleFallback: IThemeRGB =
    customColors?.['rgb-focus-subtle'] === undefined &&
    customColors?.['rgb-border-heavy'] !== undefined
      ? { 'rgb-focus-subtle': customColors['rgb-border-heavy'] }
      : {};
  const borderControlSource =
    customColors != null ? controlBorderFallback(customColors) : undefined;
  const borderControlFallback: IThemeRGB =
    borderControlSource !== undefined ? { 'rgb-border-control': borderControlSource } : {};
  const layerFallback: IThemeRGB =
    customColors != null ? layerRoleFallbacks(customColors, mode) : {};
  const focusFallback: IThemeRGB = customColors != null ? focusFallbacks(customColors) : {};
  const pressedFallback: IThemeRGB = customColors != null ? pressedFallbacks(customColors) : {};
  const primaryButtonFallback: IThemeRGB =
    customColors != null ? primaryButtonFallbacks(customColors) : {};
  const primaryInks: IThemeRGB = customColors != null ? primaryInkFallbacks(customColors) : {};
  const overlayFallback: IThemeRGB = customColors != null ? overlayFallbacks(customColors) : {};
  /**
   * Slot 8 arrived after the seven-slot scale shipped, so a stored or
   * environment theme that paints its own scale cannot name it. Filling the
   * omission from the bundled base would drop LibreChat's indigo onto that
   * theme's own surfaces — the one pairing it never checked, since the stop's
   * 3:1 mark contrast is a claim about the bundled surfaces only. The RESOLVED
   * secondary text is the one colour that tracks whatever the theme reads its
   * body copy against, whether it names its own or inherits ours, so slot 8
   * stays exactly as visible as that text; hue-neutral, it cannot collide with
   * a custom slot 1–7 under protanopia/deuteranopia either. A theme that wants
   * a hue for slot 8 names it, the way `rgb-surface-composer-hover` opts out of
   * its own fallback.
   */
  const ownsSeriesScale =
    customColors != null &&
    ([1, 2, 3, 4, 5, 6, 7] as const).some(
      (slot) => customColors[`rgb-series-${slot}`] !== undefined,
    );
  const seriesEightFallback: IThemeRGB =
    customColors?.['rgb-series-8'] === undefined && ownsSeriesScale
      ? {
          'rgb-series-8': customColors?.['rgb-text-secondary'] ?? baseColors['rgb-text-secondary'],
        }
      : {};
  /**
   * The verified mark was painted with `status-success-strong` until it earned
   * its own token, so a theme that paints what the mark is measured against —
   * the fill it used to wear, the check it carries, or the card it sits on —
   * coordinated that green and cannot have named the blue. Dropping LibreChat's
   * stock blue into such a palette puts an unchecked pairing on surfaces the
   * theme chose; keeping the old fill preserves the relationship it did check.
   * A theme that repaints anything else keeps the bundled default, and any
   * theme takes the blue by naming the token, the way
   * `rgb-surface-composer-hover` opts out of its own fallback.
   */
  const ownsMarkSurroundings =
    customColors != null && MARK_NEIGHBOURHOOD.some((token) => customColors[token] !== undefined);
  const verifiedFallback: IThemeRGB =
    ownsMarkSurroundings && customColors?.['rgb-status-verified'] === undefined
      ? {
          'rgb-status-verified':
            customColors?.['rgb-status-success-strong'] ?? baseColors['rgb-status-success-strong'],
        }
      : {};

  return {
    version: THEME_VERSION,
    name: theme.name,
    mode,
    colors: {
      ...baseColors,
      ...customColors,
      ...codeSurfaceFallback,
      ...codeBodyFallback,
      ...composerHoverFallback,
      ...shimmerBaseFallback,
      ...textMutedFallback,
      ...proseLinkFallback,
      ...proseFallback,
      ...avatarPlaceholderFallback,
      ...drawerEdgeFallback,
      ...chartWidgetSurfaceFallback,
      ...chartWidgetStrokeFallback,
      ...focusSubtleFallback,
      ...switchThumbFallback,
      ...fieldFillFallback,
      ...overlayFallback,
      ...layerFallback,
      ...tableHeaderTextFallback,
      ...tableHeaderFillFallback,
      ...borderControlFallback,
      ...focusFallback,
      ...pressedFallback,
      ...primaryButtonFallback,
      ...primaryInks,
      ...seriesEightFallback,
      ...verifiedFallback,
    } as Required<IThemeRGB>,
    appearance: withComposableShadows(withInheritedRoles(mode, definition?.appearance)),
    /** Mode last: a mode override is more specific than the theme-wide set. */
    brands: {
      ...defaultBrands,
      ...definedEntries(theme.brands),
      ...definedEntries(definition?.brands),
    },
  };
}

export function fromLegacyTheme(colors: IThemeRGB, name = 'custom'): ThemeDefinition {
  const legacyName = name.trim() || 'custom';
  const sanitizedColors = themeColorTokens.reduce<IThemeRGB>((result, token) => {
    const value = colors[token];
    if (isThemeRGB(value)) {
      result[token] = value;
    }
    return result;
  }, {});

  return {
    version: THEME_VERSION,
    name: legacyName,
    modes: {
      light: { colors: sanitizedColors },
      dark: { colors: sanitizedColors },
    },
  };
}

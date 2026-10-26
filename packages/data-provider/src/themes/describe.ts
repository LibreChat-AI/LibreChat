import type {
  IThemeAppearance,
  IThemeBrands,
  IThemeRGB,
  ResolvedThemeDefinition,
  ThemeDefinition,
} from './types';
import type { ThemeBootModes, ThemeBootStyle } from '../config';
import type { RenamedThemeRGB } from './registry';
import {
  focusFallbacks,
  resolveTheme,
  overlayFallbacks,
  pressedFallbacks,
  primaryInkRoles,
  withRenamedColors,
  MARK_NEIGHBOURHOOD,
  primaryInkFallbacks,
  controlBorderFallback,
  primaryButtonFallbacks,
  themeAppearanceProperties,
} from './registry';
import { themeBrandTokens, themeColorTokens } from '../theme';

const colorProperty = (token: keyof IThemeRGB): `--${string}` => `--${token.slice(4)}`;
const brandProperty = (token: keyof IThemeBrands): `--${string}` => `--${token}`;

export const themeOwnedProperties: readonly string[] = Object.freeze([
  ...themeColorTokens.map(colorProperty),
  ...Object.values(themeAppearanceProperties),
  ...themeBrandTokens.map(brandProperty),
]);

/** `base` is the bundled palette for the mode being applied. The adapter writes
 *  only the keys a theme names, so a derivation whose source the theme inherits
 *  rather than restates has nothing to read without it. */
export function describeThemeColors(
  input: RenamedThemeRGB,
  base?: IThemeRGB,
): Array<[string, string]> {
  const colors = withRenamedColors(input);
  const variables = themeColorTokens.reduce<Array<[string, string]>>((result, token) => {
    const value = colors[token];
    if (value !== undefined) {
      result.push([colorProperty(token), value]);
    }
    return result;
  }, []);

  if (
    colors['rgb-surface-composer-hover'] === undefined &&
    colors['rgb-surface-hover'] !== undefined
  ) {
    variables.push(['--surface-composer-hover', colors['rgb-surface-hover']]);
  }

  /**
   * Stored and environment themes predate the shimmer stops, and this adapter
   * applies only the keys a theme names, so without this they would keep the
   * stock sweep while every other color moved, and in dark mode the CSS cannot
   * recover: `.dark` declares a base outright, so the `--text-primary` fallback
   * never runs. The bright stop follows the theme's primary text color, which
   * is what it already resolves to in light. The dip has no legacy counterpart
   * and stays at its default: it is the faded half of the sweep, carried at low
   * alpha, so it reads as dimmed against any base.
   */
  if (colors['rgb-shimmer-base'] === undefined && colors['rgb-text-primary'] !== undefined) {
    variables.push(['--shimmer-base', colors['rgb-text-primary']]);
  }

  /** The dark page was `surface-primary-alt` before it had a role, as in `resolveTheme`. */
  if (colors['rgb-page-canvas'] === undefined && colors['rgb-surface-primary-alt'] !== undefined) {
    variables.push(['--page-canvas', colors['rgb-surface-primary-alt']]);
  }

  if (colors['rgb-text-muted'] === undefined && colors['rgb-text-tertiary'] !== undefined) {
    variables.push(['--text-muted', colors['rgb-text-tertiary']]);
  }

  if (
    colors['rgb-chart-widget-surface'] === undefined &&
    colors['rgb-surface-primary'] !== undefined
  ) {
    variables.push(['--chart-widget-surface', colors['rgb-surface-primary']]);
  }

  /** The switch knob was painted `surface-primary` before it had a role, as in `resolveTheme`. */
  if (colors['rgb-switch-thumb'] === undefined && colors['rgb-surface-primary'] !== undefined) {
    variables.push(['--switch-thumb', colors['rgb-surface-primary']]);
  }

  /** The field fill follows the canvas, as in `resolveTheme`. */
  if (colors['rgb-field-fill'] === undefined && colors['rgb-surface-primary'] !== undefined) {
    variables.push(['--field-fill', colors['rgb-surface-primary']]);
  }

  /** The checkbox fill follows the canvas, as in `resolveTheme`. */
  if (colors['rgb-checkbox-fill'] === undefined && colors['rgb-surface-primary'] !== undefined) {
    variables.push(['--checkbox-fill', colors['rgb-surface-primary']]);
  }

  Object.entries(overlayFallbacks(colors)).forEach(([role, value]) => {
    variables.push([colorProperty(role as keyof IThemeRGB), value]);
  });

  if (colors['rgb-table-header-text'] === undefined && colors['rgb-text-secondary'] !== undefined) {
    variables.push(['--table-header-text', colors['rgb-text-secondary']]);
  }

  if (colors['rgb-table-header-fill'] === undefined && colors['rgb-surface-dialog'] !== undefined) {
    variables.push(['--table-header-fill', colors['rgb-surface-dialog']]);
  }

  if (colors['rgb-chart-widget-stroke'] === undefined && colors['rgb-border-light'] !== undefined) {
    variables.push(['--chart-widget-stroke', colors['rgb-border-light']]);
  }

  if (colors['rgb-focus-subtle'] === undefined && colors['rgb-border-heavy'] !== undefined) {
    variables.push(['--focus-subtle', colors['rgb-border-heavy']]);
  }

  const legacyControlBorder = controlBorderFallback(colors);
  if (legacyControlBorder !== undefined) {
    variables.push(['--border-control', legacyControlBorder]);
  }

  const focus = focusFallbacks(colors);
  if (colors['rgb-focus-outline'] === undefined && focus['rgb-focus-outline'] !== undefined) {
    variables.push(['--focus-outline', focus['rgb-focus-outline']]);
  }
  if (colors['rgb-focus-control'] === undefined && focus['rgb-focus-control'] !== undefined) {
    variables.push(['--focus-control', focus['rgb-focus-control']]);
  }
  if (
    colors['rgb-border-field-focus'] === undefined &&
    focus['rgb-border-field-focus'] !== undefined
  ) {
    variables.push(['--border-field-focus', focus['rgb-border-field-focus']]);
  }

  const pressed = pressedFallbacks(colors);
  if (colors['rgb-surface-pressed'] === undefined && pressed['rgb-surface-pressed'] !== undefined) {
    variables.push(['--surface-pressed', pressed['rgb-surface-pressed']]);
  }
  if (
    colors['rgb-surface-inverted-pressed'] === undefined &&
    pressed['rgb-surface-inverted-pressed'] !== undefined
  ) {
    variables.push(['--surface-inverted-pressed', pressed['rgb-surface-inverted-pressed']]);
  }

  const primary = primaryButtonFallbacks(colors);
  if (colors['rgb-button-primary'] === undefined && primary['rgb-button-primary'] !== undefined) {
    variables.push(['--button-primary', primary['rgb-button-primary']]);
  }
  if (
    colors['rgb-button-primary-hover'] === undefined &&
    primary['rgb-button-primary-hover'] !== undefined
  ) {
    variables.push(['--button-primary-hover', primary['rgb-button-primary-hover']]);
  }

  const inks = primaryInkFallbacks(colors);
  primaryInkRoles.forEach((role) => {
    const ink = inks[role];
    if (colors[role] === undefined && ink !== undefined) {
      variables.push([`--${role.slice(4)}`, ink]);
    }
  });

  /**
   * Same rule as `resolveTheme`: a theme that paints what the mark is measured
   * against coordinated the `status-success-strong` the mark wore before it had
   * a token, so it keeps that fill rather than taking LibreChat's stock blue.
   * This adapter writes only the keys a theme names, so the inherited value
   * arrives through `base`, the bundled palette for the mode being applied.
   */
  const ownsMarkSurroundings = MARK_NEIGHBOURHOOD.some((token) => colors[token] !== undefined);
  const inheritedSuccess =
    colors['rgb-status-success-strong'] ?? base?.['rgb-status-success-strong'];
  if (
    ownsMarkSurroundings &&
    colors['rgb-status-verified'] === undefined &&
    inheritedSuccess !== undefined
  ) {
    variables.push(['--status-verified', inheritedSuccess]);
  }

  return variables;
}

/**
 * The `theme-chrome-quiet:` variant matches the literal `0`, so every spelling of zero is written as
 * it. A `none` list height is written as the viewport's, which the list's available-height cap
 * always undercuts; `none` itself would void the `min()` that applies that cap.
 */
function canonicalAppearance(key: keyof IThemeAppearance, value: string): string {
  if (key === 'listMaxHeight' && value === 'none') {
    return '100dvh';
  }
  return key === 'chromeBorderAlpha' && Number(value) === 0 ? '0' : value;
}

function mapAppearance(appearance: IThemeAppearance): Array<[string, string]> {
  return Object.entries(themeAppearanceProperties).map(([key, property]) => [
    property,
    canonicalAppearance(key as keyof IThemeAppearance, appearance[key as keyof IThemeAppearance]),
  ]);
}

/**
 * Mirrors the applied theme's `disabledStyle` on the root for host stylesheets and tests. Absent
 * means the default `dim` style. The `theme-disabled:` variants read the inherited
 * `--theme-disabled-style` property instead, so the nearest themed root decides.
 */
export const THEME_DISABLED_ATTRIBUTE = 'data-theme-disabled';

/**
 * Mirrors the applied theme's `fieldFocusStyle` on the root, like `THEME_DISABLED_ATTRIBUTE`.
 * The `theme-field-border:` variant and `Field.css` read the inherited
 * `--theme-field-focus-style` property instead, so the nearest themed root decides.
 */
export const THEME_FIELD_FOCUS_ATTRIBUTE = 'data-theme-field-focus';

/** What `applyResolvedTheme` writes on the root, as plain data a boot script can replay. */
export type ResolvedThemeStyle = ThemeBootStyle;

export function describeResolvedTheme(theme: ResolvedThemeDefinition): ResolvedThemeStyle {
  return {
    properties: [
      ...describeThemeColors(theme.colors),
      ...mapAppearance(theme.appearance),
      ...themeBrandTokens.map(
        (token) => [brandProperty(token), theme.brands[token]] as [string, string],
      ),
    ],
    attributes: {
      'data-theme': theme.name,
      ...(theme.appearance.disabledStyle === 'fill' && { [THEME_DISABLED_ATTRIBUTE]: 'fill' }),
      ...(theme.appearance.fieldFocusStyle === 'border' && {
        [THEME_FIELD_FOCUS_ATTRIBUTE]: 'border',
      }),
    },
  };
}

/** Both modes of a definition as the shell's boot script replays them. */
export function describeThemeModes(theme: ThemeDefinition): ThemeBootModes {
  return {
    light: describeResolvedTheme(resolveTheme(theme, 'light')),
    dark: describeResolvedTheme(resolveTheme(theme, 'dark')),
  };
}

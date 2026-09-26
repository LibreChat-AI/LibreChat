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
export const THEME_VERSION = 1 as const;

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

export const themeColorTokens: readonly (keyof IThemeRGB)[] = Object.freeze(
  Object.keys(defaultTheme) as Array<keyof IThemeRGB>,
);

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
 * before the role existed, so a theme that painted it keeps that edge on its
 * controls. A theme that does not keeps the bundled role, and one that names
 * the role keeps it as written.
 */
export function controlBorderFallback(colors: IThemeRGB): string | undefined {
  if (colors['rgb-border-control'] !== undefined) {
    return undefined;
  }
  return colors['rgb-border-light'];
}

export const themeAppearanceProperties: Readonly<
  Record<keyof IThemeAppearance, `--theme-${string}`>
> = Object.freeze({
  controlRadius: '--theme-control-radius',
  roundControlRadius: '--theme-round-control-radius',
  surfaceRadius: '--theme-surface-radius',
  largeSurfaceRadius: '--theme-large-surface-radius',
  radiusSm: '--theme-radius-sm',
  radiusMd: '--theme-radius-md',
  radiusLg: '--theme-radius-lg',
  radiusXl: '--theme-radius-xl',
  radius2xl: '--theme-radius-2xl',
  radius3xl: '--theme-radius-3xl',
  controlHeight: '--theme-control-height',
  spaceCompact: '--theme-space-compact',
  spaceNormal: '--theme-space-normal',
  fontFamily: '--theme-font-family',
  monoFontFamily: '--theme-mono-font-family',
  elevationSurface: '--theme-elevation-surface',
  shadow2xs: '--theme-shadow-2xs',
  shadowXs: '--theme-shadow-xs',
  shadowSm: '--theme-shadow-sm',
  shadowMd: '--theme-shadow-md',
  shadowLg: '--theme-shadow-lg',
  shadowXl: '--theme-shadow-xl',
  shadow2xl: '--theme-shadow-2xl',
  motionFast: '--theme-motion-fast',
  motionNormal: '--theme-motion-normal',
});

export const defaultAppearance: IThemeAppearance = Object.freeze({
  controlRadius: '0.75rem',
  roundControlRadius: '9999px',
  surfaceRadius: '1rem',
  largeSurfaceRadius: '1.5rem',
  radiusSm: 'calc(0.5rem - 4px)',
  radiusMd: 'calc(0.5rem - 2px)',
  radiusLg: '0.5rem',
  radiusXl: '0.75rem',
  radius2xl: '1rem',
  radius3xl: '1.5rem',
  controlHeight: '2.25rem',
  spaceCompact: '0.375rem',
  spaceNormal: '0.75rem',
  fontFamily: 'Inter, sans-serif',
  monoFontFamily:
    "'Roboto Mono', ui-monospace, SFMono-Regular, Menlo, 'Cascadia Mono', 'Liberation Mono', Consolas, monospace",
  elevationSurface: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  shadow2xs: '0 1px rgb(0 0 0 / 0.05)',
  shadowXs: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  shadowSm: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  shadowMd: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  shadowLg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  shadowXl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  shadow2xl: '0 25px 50px -12px rgb(0 0 0 / 0.25)',
  motionFast: '150ms',
  motionNormal: '200ms',
});

export const themeBrandTokens: readonly (keyof IThemeBrands)[] = Object.freeze([
  'provider-openai',
  'provider-openai-gpt4',
  'provider-openai-reasoning',
  'provider-anthropic',
  'provider-azure',
  'provider-bedrock',
  'provider-foreground',
]);

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

const rgbPattern = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/;
const cssLengthPattern = /^(0|\d*\.?\d+(px|rem|em))$/;
const cssLengthDifferencePattern =
  /^calc\(\s*\d*\.?\d+(px|rem|em)\s+[-+]\s+\d*\.?\d+(px|rem|em)\s*\)$/;
const cssDurationPattern = /^\d*\.?\d+(ms|s)$/;
const hexColorPattern = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const shadowLengthPattern = /^(-?(0|\d*\.?\d+[a-z]+)|(calc|min|max|clamp)\(.*\))$/i;
const shadowColorPattern = /^(#[0-9a-f]{3,8}|[a-z]+|[a-z-]+\(.*\))$/i;
/** Tailwind composes `--tw-shadow` into one list with the ring layers, where `none` is invalid. */
const disabledShadow = '0 0 #0000';

function isLinearGradient(value: string): boolean {
  if (!value.startsWith('linear-gradient(') || /url\s*\(|image-set/i.test(value)) {
    return false;
  }
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return i === value.length - 1;
      }
      if (depth < 0) {
        return false;
      }
    }
  }
  return false;
}

const isRGB = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const match = value.match(rgbPattern);
  return match !== null && match.slice(1).every((channel) => Number(channel) <= 255);
};

/** The bare form, or one `calc()` of two unit-bearing lengths (a bare `0` is a number there):
 *  the small radius defaults keep a px offset. */
const isLength = (value: unknown): value is string =>
  typeof value === 'string' &&
  (cssLengthPattern.test(value) || cssLengthDifferencePattern.test(value));
const isFontFamily = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && !/[;{}]/.test(value);
/** Splits on `separator` outside parentheses, so `rgb(0, 0, 0)` stays one part. Empty parts are
 *  kept, so a stray comma stays visible to the caller. */
function splitTopLevel(value: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    }
    if (depth === 0 && separator.test(char)) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}

/** A named color is indistinguishable from any other word without the browser's color parser. */
const isShadowColor = (token: string): boolean =>
  globalThis.CSS?.supports?.('color', token) ?? shadowColorPattern.test(token);

/** One layer: two to four lengths, optionally `inset` and one color, per the box-shadow grammar. */
function isShadowLayer(layer: string): boolean {
  const tokens = splitTopLevel(layer, /\s/).filter((token) => token.length > 0);
  const lengths = tokens.filter((token) => shadowLengthPattern.test(token)).length;
  const insets = tokens.filter((token) => token.toLowerCase() === 'inset').length;
  const colors = tokens.filter(
    (token) => !shadowLengthPattern.test(token) && token.toLowerCase() !== 'inset',
  );
  return (
    lengths >= 2 && lengths <= 4 && insets <= 1 && colors.length <= 1 && colors.every(isShadowColor)
  );
}

/**
 * A shadow must be concrete: a browser defers its check of any value holding `var()`, `env()` or
 * `attr()` until substitution, so such a value could never be validated before it reaches the
 * ring layers.
 */
const isShadow = (value: unknown): value is string => {
  if (typeof value !== 'string' || /[;{}]|url\s*\(|(var|env|attr)\s*\(/i.test(value)) {
    return false;
  }
  if (value.trim().toLowerCase() === 'none') {
    return true;
  }
  const layers = splitTopLevel(value, /,/);
  if (layers.some((layer) => layer.length === 0) || !layers.every(isShadowLayer)) {
    return false;
  }
  return globalThis.CSS?.supports?.('box-shadow', value) ?? true;
};
const isDuration = (value: unknown): value is string =>
  typeof value === 'string' && cssDurationPattern.test(value);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype.constructor?.name === 'Object';
  } catch {
    return false;
  }
};

const appearanceValidators: Record<keyof IThemeAppearance, (value: unknown) => boolean> = {
  controlRadius: isLength,
  roundControlRadius: isLength,
  surfaceRadius: isLength,
  largeSurfaceRadius: isLength,
  radiusSm: isLength,
  radiusMd: isLength,
  radiusLg: isLength,
  radiusXl: isLength,
  radius2xl: isLength,
  radius3xl: isLength,
  controlHeight: isLength,
  spaceCompact: isLength,
  spaceNormal: isLength,
  fontFamily: isFontFamily,
  monoFontFamily: isFontFamily,
  /** Released themes may hold `var()` here, so this role keeps its original, looser check. */
  elevationSurface: (value) =>
    typeof value === 'string' && value.trim().length > 0 && !/[;{}]|url\s*\(/i.test(value),
  shadow2xs: isShadow,
  shadowXs: isShadow,
  shadowSm: isShadow,
  shadowMd: isShadow,
  shadowLg: isShadow,
  shadowXl: isShadow,
  shadow2xl: isShadow,
  motionFast: isDuration,
  motionNormal: isDuration,
};

const isAppearanceKey = (key: string): key is keyof IThemeAppearance =>
  Object.prototype.hasOwnProperty.call(appearanceValidators, key);

/**
 * A token added after this reader shipped is ignored rather than rejected, so a newer definition
 * degrades to the defaults for what this version cannot paint instead of losing every value it
 * can. It never reaches the DOM, but it must still look like a token: a camelCase name and a
 * plain CSS value, never a declaration or rule break.
 */
const isFutureAppearance = (key: string, value: unknown): boolean =>
  /^[a-z][a-zA-Z0-9]*$/.test(key) && typeof value === 'string' && !/[;{}<>]|url\s*\(/i.test(value);

/** The appearance tokens this reader does not know, which `resolveTheme` leaves out. */
export function collectThemeWarnings(theme: ThemeDefinition): string[] {
  if (!isPlainRecord(theme) || !isPlainRecord(theme.modes)) {
    return [];
  }
  return (['light', 'dark'] as const).flatMap((mode) => {
    const appearance: unknown = isPlainRecord(theme.modes[mode])
      ? theme.modes[mode]?.appearance
      : undefined;
    if (!isPlainRecord(appearance)) {
      return [];
    }
    return Object.keys(appearance)
      .filter((key) => !isAppearanceKey(key))
      .map((key) => `Unknown ${mode} appearance token ignored: ${key}`);
  });
}

/** Shared by the theme-wide `brands` and each mode's override block. */
function collectBrandErrors(brands: unknown): string[] {
  if (!isPlainRecord(brands)) {
    return [];
  }

  return Object.entries(brands).flatMap(([key, value]) => {
    if (!themeBrandTokens.includes(key as keyof IThemeBrands)) {
      return [`Unknown brand token: ${key}`];
    }
    /** Only the glyph is a flat colour; a fill may also be a gradient. */
    const isColorOnly = key === 'provider-foreground';
    const isValidBrand =
      typeof value === 'string' &&
      (isColorOnly
        ? hexColorPattern.test(value)
        : hexColorPattern.test(value) || isLinearGradient(value));
    return value !== undefined && !isValidBrand ? [`Invalid brand value for ${key}: ${value}`] : [];
  });
}

export function validateThemeDefinition(theme: ThemeDefinition): string[] {
  const errors: string[] = [];

  if (!isPlainRecord(theme)) {
    return ['Theme definition must be an object'];
  }

  Object.keys(theme).forEach((key) => {
    if (key !== 'version' && key !== 'name' && key !== 'modes' && key !== 'brands') {
      errors.push(`Unknown theme field: ${key}`);
    }
  });

  if (theme.version !== THEME_VERSION) {
    errors.push(`Unsupported theme version: ${theme.version}`);
  }
  if (typeof theme.name !== 'string' || !theme.name.trim()) {
    errors.push('Theme name is required');
  }
  if (!isPlainRecord(theme.modes)) {
    errors.push('Theme modes must be an object');
    return errors;
  }

  Object.keys(theme.modes).forEach((mode) => {
    if (mode !== 'light' && mode !== 'dark') {
      errors.push(`Unknown theme mode: ${mode}`);
    }
  });

  (['light', 'dark'] as const).forEach((mode) => {
    const definition = theme.modes[mode];
    if (definition === undefined) {
      return;
    }

    if (!isPlainRecord(definition)) {
      errors.push(`Theme mode ${mode} must be an object`);
      return;
    }

    Object.keys(definition).forEach((key) => {
      if (key !== 'colors' && key !== 'appearance' && key !== 'brands') {
        errors.push(`Unknown ${mode} theme field: ${key}`);
      }
    });

    if (definition.colors !== undefined && !isPlainRecord(definition.colors)) {
      errors.push(`Theme colors for ${mode} must be an object`);
    } else {
      Object.entries(definition.colors ?? {}).forEach(([key, value]) => {
        if (!themeColorTokens.includes(key as keyof IThemeRGB)) {
          errors.push(`Unknown color token: ${key}`);
          return;
        }
        if (value !== undefined && !isRGB(value)) {
          errors.push(`Invalid RGB value for ${key}: ${value}`);
        }
      });
    }

    if (definition.appearance !== undefined && !isPlainRecord(definition.appearance)) {
      errors.push(`Theme appearance for ${mode} must be an object`);
    } else {
      Object.entries(definition.appearance ?? {}).forEach(([key, value]) => {
        const isKnown = isAppearanceKey(key);
        const isValid = isKnown ? appearanceValidators[key](value) : isFutureAppearance(key, value);
        if (value !== undefined && !isValid) {
          errors.push(`Invalid appearance value for ${key}: ${value}`);
        }
      });
    }

    if (definition.brands !== undefined && !isPlainRecord(definition.brands)) {
      errors.push(`Theme brands for ${mode} must be an object`);
    } else {
      errors.push(...collectBrandErrors(definition.brands));
    }
  });

  if (theme.brands !== undefined && !isPlainRecord(theme.brands)) {
    errors.push('Theme brands must be an object');
  } else {
    errors.push(...collectBrandErrors(theme.brands));
  }

  return errors;
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

function knownAppearance(appearance?: Partial<IThemeAppearance>): Partial<IThemeAppearance> {
  return Object.fromEntries(
    Object.entries(definedEntries(appearance)).filter(([key]) => isAppearanceKey(key)),
  );
}

const shadowAppearanceKeys: ReadonlyArray<keyof IThemeAppearance> = [
  'elevationSurface',
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

export function resolveTheme(theme: ThemeDefinition, mode: ThemeMode): ResolvedThemeDefinition {
  const errors = validateThemeDefinition(theme);
  if (errors.length > 0) {
    throw new TypeError(errors.join('\n'));
  }

  const baseColors = mode === 'dark' ? darkTheme : defaultTheme;
  const definition = theme.modes[mode];
  const customColors = definition?.colors;
  const composerHoverFallback =
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
  const codeSurfaceFallback =
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
  const codeBodyFallback =
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
  const shimmerBaseFallback =
    customColors?.['rgb-shimmer-base'] === undefined &&
    customColors?.['rgb-text-primary'] !== undefined
      ? { 'rgb-shimmer-base': customColors['rgb-text-primary'] }
      : {};
  const textMutedFallback =
    customColors?.['rgb-text-muted'] === undefined &&
    customColors?.['rgb-text-tertiary'] !== undefined
      ? { 'rgb-text-muted': customColors['rgb-text-tertiary'] }
      : {};
  const chartWidgetSurfaceFallback =
    customColors?.['rgb-chart-widget-surface'] === undefined &&
    customColors?.['rgb-surface-primary'] !== undefined
      ? { 'rgb-chart-widget-surface': customColors['rgb-surface-primary'] }
      : {};
  const chartWidgetStrokeFallback =
    customColors?.['rgb-chart-widget-stroke'] === undefined &&
    customColors?.['rgb-border-light'] !== undefined
      ? { 'rgb-chart-widget-stroke': customColors['rgb-border-light'] }
      : {};
  const borderControlSource =
    customColors != null ? controlBorderFallback(customColors) : undefined;
  const borderControlFallback =
    borderControlSource !== undefined ? { 'rgb-border-control': borderControlSource } : {};
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
  const seriesEightFallback =
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
  const verifiedFallback =
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
      ...chartWidgetSurfaceFallback,
      ...chartWidgetStrokeFallback,
      ...borderControlFallback,
      ...seriesEightFallback,
      ...verifiedFallback,
    } as Required<IThemeRGB>,
    appearance: withComposableShadows({
      ...defaultAppearance,
      ...knownAppearance(definition?.appearance),
    }),
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
    if (isRGB(value)) {
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

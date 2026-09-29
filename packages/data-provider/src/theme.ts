/**
 * The theme token contract shared by the client registry, which paints a definition, and the
 * server, which checks `interface.theme` when librechat.yaml loads. Both read these lists, so a
 * token added here is accepted everywhere at once.
 */
export const THEME_VERSION = 1 as const;

/** The names `interface.theme` may give instead of an inline definition. */
export const bundledThemeNames = Object.freeze(['librechat', 'clickhouse'] as const);

export type BundledThemeName = (typeof bundledThemeNames)[number];

export const isBundledThemeName = (value: string): value is BundledThemeName =>
  (bundledThemeNames as readonly string[]).includes(value);

export const themeColorTokens = Object.freeze([
  'rgb-text-primary',
  'rgb-text-secondary',
  'rgb-text-secondary-alt',
  'rgb-text-tertiary',
  'rgb-text-muted',
  'rgb-text-warning',
  'rgb-text-destructive',
  'rgb-shimmer-base',
  'rgb-shimmer-dip',
  'rgb-link',
  'rgb-link-hover',
  'rgb-link-visited',
  'rgb-accent-primary',
  'rgb-accent-primary-hover',
  'rgb-ring-primary',
  'rgb-focus-outline',
  'rgb-focus-control',
  'rgb-header-primary',
  'rgb-header-hover',
  'rgb-header-button-hover',
  'rgb-surface-active',
  'rgb-surface-active-alt',
  'rgb-surface-hover',
  'rgb-surface-hover-alt',
  'rgb-surface-pressed',
  'rgb-surface-composer-hover',
  'rgb-surface-primary',
  'rgb-chart-widget-surface',
  'rgb-chart-widget-stroke',
  'rgb-surface-primary-alt',
  'rgb-surface-primary-contrast',
  'rgb-surface-secondary',
  'rgb-surface-secondary-alt',
  'rgb-surface-tertiary',
  'rgb-surface-tertiary-alt',
  'rgb-surface-dialog',
  'rgb-surface-overlay',
  'rgb-surface-submit',
  'rgb-surface-submit-hover',
  'rgb-surface-destructive',
  'rgb-surface-destructive-hover',
  'rgb-surface-chat',
  'rgb-surface-code',
  'rgb-surface-code-body',
  'rgb-surface-inverted',
  'rgb-surface-inverted-hover',
  'rgb-surface-inverted-pressed',
  'rgb-text-inverted',
  'rgb-surface-fixed',
  'rgb-surface-fixed-hover',
  'rgb-text-fixed',
  'rgb-border-light',
  'rgb-border-medium',
  'rgb-border-medium-alt',
  'rgb-border-heavy',
  'rgb-border-xheavy',
  'rgb-border-destructive',
  'rgb-border-control',
  'rgb-surface-disabled',
  'rgb-text-disabled',
  'rgb-border-disabled',
  'rgb-status-success',
  'rgb-status-success-subtle',
  'rgb-status-success-border',
  'rgb-status-success-strong',
  'rgb-status-info',
  'rgb-status-info-subtle',
  'rgb-status-info-border',
  'rgb-status-info-strong',
  'rgb-status-warning',
  'rgb-status-warning-subtle',
  'rgb-status-warning-border',
  'rgb-status-warning-strong',
  'rgb-status-error',
  'rgb-status-error-subtle',
  'rgb-status-error-border',
  'rgb-status-error-strong',
  'rgb-status-neutral',
  'rgb-status-neutral-subtle',
  'rgb-status-neutral-border',
  'rgb-status-verified',
  'rgb-text-on-status',
  'rgb-brand-purple',
  'rgb-syntax-text',
  'rgb-syntax-comment',
  'rgb-syntax-meta',
  'rgb-syntax-builtin',
  'rgb-syntax-keyword',
  'rgb-syntax-string',
  'rgb-syntax-attr',
  'rgb-syntax-title',
  'rgb-series-1',
  'rgb-series-2',
  'rgb-series-3',
  'rgb-series-4',
  'rgb-series-5',
  'rgb-series-6',
  'rgb-series-7',
  'rgb-series-8',
  'rgb-switch-unchecked',
  'rgb-presentation',
] as const);

export type ThemeColorToken = (typeof themeColorTokens)[number];

export const themeBrandTokens = Object.freeze([
  'provider-openai',
  'provider-openai-gpt4',
  'provider-openai-reasoning',
  'provider-anthropic',
  'provider-azure',
  'provider-bedrock',
  'provider-foreground',
] as const);

export type ThemeBrandToken = (typeof themeBrandTokens)[number];

/** One problem in a theme definition: where it is, relative to the definition, and what it is. */
export interface ThemeIssue {
  path: string[];
  message: string;
}

const rgbPattern = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/;
const cssLengthPattern = /^(0|\d*\.?\d+(px|rem|em))$/;
const cssLengthDifferencePattern =
  /^calc\(\s*\d*\.?\d+(px|rem|em)\s+[-+]\s+\d*\.?\d+(px|rem|em)\s*\)$/;
const cssDurationPattern = /^\d*\.?\d+(ms|s)$/;
/** A unitless ratio, written bare or as one `calc()` quotient the way Tailwind's scale is. */
const cssLineHeightPattern = /^(\d*\.?\d+|calc\(\s*\d*\.?\d+\s*\/\s*\d*\.?\d+\s*\))$/;
const hexColorPattern = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const shadowLengthPattern = /^(-?(0|\d*\.?\d+[a-z]+)|(calc|min|max|clamp)\(.*\))$/i;
const shadowColorPattern = /^(#[0-9a-f]{3,8}|[a-z]+|[a-z-]+\(.*\))$/i;

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

export const isThemeRGB = (value: unknown): value is string => {
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
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
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

/** A named color is indistinguishable from any other word without the browser's color parser,
 *  so outside a browser the pattern decides. */
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
/** A ratio whose `calc()` divides by zero is dropped by the browser, so it is rejected here. */
const isLineHeight = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const match = cssLineHeightPattern.exec(value.trim());
  if (!match) {
    return isLength(value);
  }
  const divisor = /\/\s*(\d*\.?\d+)\s*\)$/.exec(match[0]);
  return divisor === null || Number(divisor[1]) > 0;
};
const isDuration = (value: unknown): value is string =>
  typeof value === 'string' && cssDurationPattern.test(value);

export const isPlainThemeRecord = (value: unknown): value is Record<string, unknown> => {
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

const appearanceValidators = {
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
  /** `dim` fades a disabled control to half opacity; `fill` paints it in the disabled roles. */
  disabledStyle: (value: unknown) => value === 'dim' || value === 'fill',
  fontFamily: isFontFamily,
  monoFontFamily: isFontFamily,
  displayFontFamily: isFontFamily,
  textXs: isLength,
  textSm: isLength,
  textBase: isLength,
  textLg: isLength,
  textXl: isLength,
  text2xl: isLength,
  leadingXs: isLineHeight,
  leadingSm: isLineHeight,
  leadingBase: isLineHeight,
  leadingLg: isLineHeight,
  leadingXl: isLineHeight,
  leading2xl: isLineHeight,
  /** Released themes may hold `var()` here, so this role keeps its original, looser check. */
  elevationSurface: (value: unknown) =>
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
} satisfies Record<string, (value: unknown) => boolean>;

export type ThemeAppearanceToken = keyof typeof appearanceValidators;

export const themeAppearanceTokens = Object.freeze(
  Object.keys(appearanceValidators) as ThemeAppearanceToken[],
);

export const isThemeAppearanceToken = (key: string): key is ThemeAppearanceToken =>
  Object.prototype.hasOwnProperty.call(appearanceValidators, key);

const colorTokenSet: ReadonlySet<string> = new Set<string>(themeColorTokens);
const brandTokenSet: ReadonlySet<string> = new Set<string>(themeBrandTokens);
const themeModes = ['light', 'dark'] as const;

/**
 * A token added after this reader shipped is ignored rather than rejected, so a newer definition
 * degrades to the defaults for what this version cannot paint instead of losing every value it
 * can. It never reaches the DOM, but it must still look like a token: a camelCase name and a
 * plain CSS value, never a declaration or rule break.
 */
const isFutureAppearance = (key: string, value: unknown): boolean =>
  /^[a-z][a-zA-Z0-9]*$/.test(key) && typeof value === 'string' && !/[;{}<>]|url\s*\(/i.test(value);

/**
 * The same allowance for a color role: a well-formed `rgb-` name holding an RGB triplet is one
 * this reader predates, so it is ignored rather than rejecting a theme a newer server or build
 * wrote. Anything else under an unknown name is still an error.
 */
const isFutureColor = (key: string, value: unknown): boolean =>
  /^rgb-[a-z][a-z0-9-]*$/.test(key) && isThemeRGB(value);

const issue = (path: string[], message: string): ThemeIssue => ({ path, message });

export interface ThemeReadOptions {
  /**
   * A reader that may be older than the definition it paints (a cached client reading a newer
   * server's theme) ignores well-formed color roles it predates. The server reads its own config
   * with its own token list, so there an unknown role is a typo and stays an error.
   */
  ignoreFutureColors?: boolean;
}

/** The color and appearance tokens this reader does not know, which a resolved theme leaves out. */
export function collectThemeWarningIssues(
  theme: unknown,
  { ignoreFutureColors = false }: ThemeReadOptions = {},
): ThemeIssue[] {
  if (!isPlainThemeRecord(theme) || !isPlainThemeRecord(theme.modes)) {
    return [];
  }
  const modes = theme.modes;
  return themeModes.flatMap((mode) => {
    const definition = modes[mode];
    if (!isPlainThemeRecord(definition)) {
      return [];
    }
    const { colors, appearance } = definition;
    const futureColors =
      ignoreFutureColors && isPlainThemeRecord(colors)
        ? Object.entries(colors)
            .filter(([key, value]) => !colorTokenSet.has(key) && isFutureColor(key, value))
            .map(([key]) =>
              issue(['modes', mode, 'colors', key], `Unknown ${mode} color token ignored: ${key}`),
            )
        : [];
    const futureAppearance = isPlainThemeRecord(appearance)
      ? Object.keys(appearance)
          .filter((key) => !isThemeAppearanceToken(key))
          .map((key) =>
            issue(
              ['modes', mode, 'appearance', key],
              `Unknown ${mode} appearance token ignored: ${key}`,
            ),
          )
      : [];
    return [...futureColors, ...futureAppearance];
  });
}

/** Shared by the theme-wide `brands` and each mode's override block. */
function collectBrandIssues(brands: unknown, path: string[]): ThemeIssue[] {
  if (!isPlainThemeRecord(brands)) {
    return [];
  }

  return Object.entries(brands).flatMap(([key, value]) => {
    if (!brandTokenSet.has(key)) {
      return [issue([...path, key], `Unknown brand token: ${key}`)];
    }
    /** Only the glyph is a flat colour; a fill may also be a gradient. */
    const isColorOnly = key === 'provider-foreground';
    const isValidBrand =
      typeof value === 'string' &&
      (isColorOnly
        ? hexColorPattern.test(value)
        : hexColorPattern.test(value) || isLinearGradient(value));
    return value !== undefined && !isValidBrand
      ? [issue([...path, key], `Invalid brand value for ${key}: ${value}`)]
      : [];
  });
}

function collectModeIssues(
  mode: 'light' | 'dark',
  definition: unknown,
  { ignoreFutureColors = false }: ThemeReadOptions,
): ThemeIssue[] {
  const base = ['modes', mode];
  if (definition === undefined) {
    return [];
  }
  if (!isPlainThemeRecord(definition)) {
    return [issue(base, `Theme mode ${mode} must be an object`)];
  }

  const issues: ThemeIssue[] = Object.keys(definition)
    .filter((key) => key !== 'colors' && key !== 'appearance' && key !== 'brands')
    .map((key) => issue([...base, key], `Unknown ${mode} theme field: ${key}`));

  const { colors, appearance, brands } = definition;
  if (colors !== undefined && !isPlainThemeRecord(colors)) {
    issues.push(issue([...base, 'colors'], `Theme colors for ${mode} must be an object`));
  } else {
    Object.entries(colors ?? {}).forEach(([key, value]) => {
      const path = [...base, 'colors', key];
      if (!colorTokenSet.has(key)) {
        if (!ignoreFutureColors || !isFutureColor(key, value)) {
          issues.push(issue(path, `Unknown color token: ${key}`));
        }
        return;
      }
      if (value !== undefined && !isThemeRGB(value)) {
        issues.push(issue(path, `Invalid RGB value for ${key}: ${value}`));
      }
    });
  }

  if (appearance !== undefined && !isPlainThemeRecord(appearance)) {
    issues.push(issue([...base, 'appearance'], `Theme appearance for ${mode} must be an object`));
  } else {
    Object.entries(appearance ?? {}).forEach(([key, value]) => {
      const isValid = isThemeAppearanceToken(key)
        ? appearanceValidators[key](value)
        : isFutureAppearance(key, value);
      if (value !== undefined && !isValid) {
        issues.push(
          issue([...base, 'appearance', key], `Invalid appearance value for ${key}: ${value}`),
        );
      }
    });
  }

  if (brands !== undefined && !isPlainThemeRecord(brands)) {
    issues.push(issue([...base, 'brands'], `Theme brands for ${mode} must be an object`));
  } else {
    issues.push(...collectBrandIssues(brands, [...base, 'brands']));
  }
  return issues;
}

/** Every reason a definition cannot be painted; empty when it can. */
export function collectThemeIssues(theme: unknown, options: ThemeReadOptions = {}): ThemeIssue[] {
  if (!isPlainThemeRecord(theme)) {
    return [issue([], 'Theme definition must be an object')];
  }

  const issues: ThemeIssue[] = Object.keys(theme)
    .filter((key) => key !== 'version' && key !== 'name' && key !== 'modes' && key !== 'brands')
    .map((key) => issue([key], `Unknown theme field: ${key}`));

  if (theme.version !== THEME_VERSION) {
    issues.push(issue(['version'], `Unsupported theme version: ${theme.version}`));
  }
  if (typeof theme.name !== 'string' || !theme.name.trim()) {
    issues.push(issue(['name'], 'Theme name is required'));
  }
  const modes = theme.modes;
  if (!isPlainThemeRecord(modes)) {
    issues.push(issue(['modes'], 'Theme modes must be an object'));
    return issues;
  }

  Object.keys(modes)
    .filter((mode) => mode !== 'light' && mode !== 'dark')
    .forEach((mode) => issues.push(issue(['modes', mode], `Unknown theme mode: ${mode}`)));

  themeModes.forEach((mode) => issues.push(...collectModeIssues(mode, modes[mode], options)));

  if (theme.brands !== undefined && !isPlainThemeRecord(theme.brands)) {
    issues.push(issue(['brands'], 'Theme brands must be an object'));
  } else {
    issues.push(...collectBrandIssues(theme.brands, ['brands']));
  }

  return issues;
}

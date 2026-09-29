import type { IThemeAppearance, IThemeRGB, ThemeMode } from '../types';
import { clickHouseTheme } from './clickhouse';
import snapshot from './clickui.json';

/**
 * Drift guard for the ClickHouse theme. `clickui.json` is a snapshot of the Click UI tokens the
 * theme cites, copied verbatim from the tag it records; the maps below name the token behind each
 * theme value. Editing a theme value, or refreshing the snapshot from a newer Click UI tag, fails
 * here with the theme key and the token it no longer matches.
 *
 * To refresh: check out the new tag, read each token below out of `files` for its mode, write the
 * verbatim values, tag and commit into `clickui.json`, then reconcile what this spec reports.
 */

type Rgba = [number, number, number, number];
/** Click UI writes its line heights as bare numbers; every other token is a string. */
type Snapshot = Record<ThemeMode, Record<string, string | number>>;

const tokens: Snapshot = { light: snapshot.light, dark: snapshot.dark };
const modes: ThemeMode[] = ['light', 'dark'];

const colorSources: Record<ThemeMode, Partial<Record<keyof IThemeRGB, string>>> = {
  light: {
    'rgb-text-primary': 'global.color.text.default',
    'rgb-text-secondary': 'palette.slate.700',
    'rgb-text-secondary-alt': 'palette.slate.700',
    'rgb-text-tertiary': 'palette.slate.700',
    'rgb-text-muted': 'global.color.text.muted',
    'rgb-text-warning': 'click.global.color.text.warning',
    'rgb-text-destructive': 'click.global.color.text.danger',
    'rgb-shimmer-base': 'global.color.text.default',
    'rgb-shimmer-dip': 'palette.slate.500',
    'rgb-link': 'palette.info.500',
    'rgb-link-hover': 'global.color.text.link.hover',
    'rgb-link-visited': 'palette.violet.600',
    'rgb-accent-primary': 'global.color.accent.default',
    'rgb-accent-primary-hover': 'palette.neutral.712',
    'rgb-ring-primary': 'global.color.outline.default',
    'rgb-focus-outline': 'global.color.outline.default',
    'rgb-focus-control': 'global.color.outline.default',
    'rgb-header-primary': 'global.color.background.default',
    'rgb-header-hover': 'global.color.background.muted',
    'rgb-header-button-hover': 'global.color.background.muted',
    'rgb-surface-active': 'palette.slate.100',
    'rgb-surface-active-alt': 'palette.slate.200',
    'rgb-surface-hover': 'palette.slate.100',
    'rgb-surface-hover-alt': 'palette.slate.200',
    'rgb-surface-pressed': 'click.button.iconButton.color.primary.background.active',
    'rgb-surface-composer-hover': 'palette.slate.100',
    'rgb-surface-primary': 'global.color.background.default',
    'rgb-chart-widget-surface': 'global.color.background.default',
    'rgb-chart-widget-stroke': 'global.color.stroke.default',
    'rgb-surface-primary-alt': 'global.color.background.split',
    'rgb-surface-primary-contrast': 'palette.slate.100',
    'rgb-surface-secondary': 'global.color.background.muted',
    'rgb-surface-secondary-alt': 'palette.slate.100',
    'rgb-surface-tertiary': 'global.color.background.muted',
    'rgb-surface-tertiary-alt': 'global.color.background.default',
    'rgb-surface-dialog': 'global.color.background.default',
    'rgb-surface-overlay': 'click.dialog.color.opaqueBackground.default',
    'rgb-surface-submit': 'global.color.accent.default',
    'rgb-surface-submit-hover': 'palette.neutral.712',
    'rgb-surface-destructive': 'palette.danger.600',
    'rgb-surface-destructive-hover': 'palette.danger.700',
    'rgb-surface-chat': 'global.color.background.default',
    'rgb-surface-code': 'click.codeblock.lightMode.color.background.default',
    'rgb-surface-code-body': 'click.codeblock.lightMode.color.background.default',
    'rgb-surface-inverted': 'palette.neutral.900',
    'rgb-surface-inverted-hover': 'palette.neutral.712',
    'rgb-surface-inverted-pressed': 'click.button.basic.color.primary.background.active',
    'rgb-text-inverted': 'palette.neutral.0',
    'rgb-surface-fixed': 'palette.neutral.0',
    'rgb-surface-fixed-hover': 'palette.slate.100',
    'rgb-text-fixed': 'palette.slate.900',
    'rgb-border-light': 'global.color.stroke.default',
    'rgb-border-medium': 'global.color.stroke.default',
    'rgb-border-medium-alt': 'global.color.stroke.default',
    'rgb-border-heavy': 'global.color.stroke.intense',
    'rgb-border-xheavy': 'palette.slate.500',
    'rgb-border-destructive': 'palette.danger.600',
    'rgb-border-control': 'palette.slate.500',
    'rgb-surface-disabled': 'click.button.basic.color.primary.background.disabled',
    'rgb-text-disabled': 'global.color.text.disabled',
    'rgb-border-disabled': 'click.field.color.stroke.disabled',
    'rgb-status-success': 'palette.success.800',
    'rgb-status-success-subtle': 'global.color.feedback.success.background',
    'rgb-status-success-border': 'palette.success.200',
    'rgb-status-success-strong': 'global.color.feedback.success.foreground',
    'rgb-status-info': 'palette.info.600',
    'rgb-status-info-subtle': 'global.color.feedback.info.background',
    'rgb-status-info-border': 'palette.info.200',
    'rgb-status-info-strong': 'palette.info.600',
    'rgb-status-warning': 'global.color.feedback.warning.foreground',
    'rgb-status-warning-subtle': 'global.color.feedback.warning.background',
    'rgb-status-warning-border': 'palette.warning.200',
    'rgb-status-warning-strong': 'palette.warning.700',
    'rgb-status-error': 'global.color.feedback.danger.foreground',
    'rgb-status-error-subtle': 'global.color.feedback.danger.background',
    'rgb-status-error-border': 'palette.danger.200',
    'rgb-status-error-strong': 'palette.danger.600',
    'rgb-status-neutral': 'global.color.feedback.neutral.foreground',
    'rgb-status-neutral-subtle': 'global.color.feedback.neutral.background',
    'rgb-status-neutral-border': 'global.color.feedback.neutral.stroke',
    'rgb-status-verified': 'palette.info.600',
    'rgb-text-on-status': 'palette.neutral.0',
    'rgb-brand-purple': 'palette.violet.600',
    'rgb-syntax-text': 'click.codeblock.lightMode.color.text.default',
    'rgb-syntax-comment': 'global.color.text.muted',
    'rgb-syntax-meta': 'palette.slate.700',
    'rgb-syntax-builtin': 'palette.sunrise.700',
    'rgb-syntax-keyword': 'palette.info.600',
    'rgb-syntax-string': 'palette.success.800',
    'rgb-syntax-attr': 'palette.fuchsia.700',
    'rgb-syntax-title': 'palette.warning.700',
    'rgb-series-1': 'global.color.chart.default.blue',
    'rgb-series-2': 'palette.warning.500',
    'rgb-series-3': 'palette.success.700',
    'rgb-series-4': 'global.color.chart.default.fuchsia',
    'rgb-series-5': 'palette.sunrise.600',
    'rgb-series-6': 'global.color.chart.default.violet',
    'rgb-series-7': 'palette.babyblue.600',
    'rgb-series-8': 'global.color.chart.default.teal',
    'rgb-switch-unchecked': 'palette.slate.500',
    'rgb-presentation': 'global.color.background.default',
  },
  dark: {
    'rgb-text-primary': 'global.color.text.default',
    'rgb-text-secondary': 'global.color.text.muted',
    'rgb-text-secondary-alt': 'global.color.text.muted',
    'rgb-text-tertiary': 'global.color.text.muted',
    'rgb-text-muted': 'global.color.text.muted',
    'rgb-text-warning': 'click.global.color.text.warning',
    'rgb-text-destructive': 'click.global.color.text.danger',
    'rgb-shimmer-base': 'global.color.text.default',
    'rgb-shimmer-dip': 'global.color.text.muted',
    'rgb-link': 'global.color.text.link.default',
    'rgb-link-hover': 'global.color.text.link.hover',
    'rgb-link-visited': 'palette.violet.300',
    'rgb-accent-primary': 'global.color.accent.default',
    'rgb-accent-primary-hover': 'palette.brand.200',
    'rgb-ring-primary': 'global.color.outline.default',
    'rgb-focus-outline': 'global.color.outline.default',
    'rgb-focus-control': 'global.color.outline.default',
    'rgb-header-primary': 'global.color.background.default',
    'rgb-header-hover': 'global.color.background.muted',
    'rgb-header-button-hover': 'global.color.background.muted',
    'rgb-surface-active': 'palette.neutral.700',
    'rgb-surface-active-alt': 'palette.neutral.712',
    'rgb-surface-hover': 'palette.neutral.712',
    'rgb-surface-hover-alt': 'palette.neutral.700',
    'rgb-surface-pressed': 'click.button.iconButton.color.primary.background.active',
    'rgb-surface-composer-hover': 'palette.neutral.712',
    'rgb-surface-primary': 'global.color.background.default',
    'rgb-chart-widget-surface': 'global.color.background.muted',
    'rgb-chart-widget-stroke': 'global.color.stroke.default',
    'rgb-surface-primary-alt': 'global.color.background.split',
    'rgb-surface-primary-contrast': 'palette.neutral.712',
    'rgb-surface-secondary': 'global.color.background.muted',
    'rgb-surface-secondary-alt': 'palette.neutral.712',
    'rgb-surface-tertiary': 'global.color.background.muted',
    'rgb-surface-tertiary-alt': 'palette.neutral.712',
    'rgb-surface-dialog': 'global.color.background.default',
    'rgb-surface-submit': 'global.color.accent.default',
    'rgb-surface-submit-hover': 'palette.brand.200',
    'rgb-surface-destructive': 'palette.danger.300',
    'rgb-surface-destructive-hover': 'palette.danger.200',
    'rgb-surface-chat': 'global.color.background.default',
    'rgb-surface-code': 'click.codeblock.darkMode.color.background.default',
    'rgb-surface-code-body': 'click.codeblock.darkMode.color.background.default',
    'rgb-surface-inverted': 'click.button.basic.color.primary.background.default',
    'rgb-surface-inverted-hover': 'click.button.basic.color.primary.background.hover',
    'rgb-surface-inverted-pressed': 'click.button.basic.color.primary.background.active',
    'rgb-text-inverted': 'click.button.basic.color.primary.text.default',
    'rgb-surface-fixed': 'palette.neutral.0',
    'rgb-surface-fixed-hover': 'palette.slate.100',
    'rgb-text-fixed': 'palette.slate.900',
    'rgb-border-light': 'global.color.stroke.default',
    'rgb-border-medium': 'global.color.stroke.default',
    'rgb-border-medium-alt': 'global.color.stroke.default',
    'rgb-border-heavy': 'global.color.stroke.intense',
    'rgb-border-xheavy': 'palette.neutral.500',
    'rgb-border-destructive': 'palette.danger.300',
    'rgb-border-control': 'palette.neutral.500',
    'rgb-surface-disabled': 'click.button.basic.color.primary.background.disabled',
    'rgb-text-disabled': 'global.color.text.disabled',
    'rgb-border-disabled': 'click.field.color.stroke.disabled',
    'rgb-status-success': 'global.color.feedback.success.foreground',
    'rgb-status-success-subtle': 'global.color.feedback.success.background',
    'rgb-status-success-border': 'palette.success.800',
    'rgb-status-success-strong': 'palette.success.500',
    'rgb-status-info': 'global.color.feedback.info.foreground',
    'rgb-status-info-subtle': 'global.color.feedback.info.background',
    'rgb-status-info-border': 'palette.info.600',
    'rgb-status-info-strong': 'palette.info.300',
    'rgb-status-warning': 'global.color.feedback.warning.foreground',
    'rgb-status-warning-subtle': 'global.color.feedback.warning.background',
    'rgb-status-warning-border': 'palette.warning.700',
    'rgb-status-warning-strong': 'palette.warning.300',
    'rgb-status-error': 'global.color.feedback.danger.foreground',
    'rgb-status-error-subtle': 'global.color.feedback.danger.background',
    'rgb-status-error-border': 'palette.danger.700',
    'rgb-status-error-strong': 'palette.danger.300',
    'rgb-status-neutral': 'global.color.feedback.neutral.foreground',
    'rgb-status-neutral-subtle': 'global.color.feedback.neutral.background',
    'rgb-status-neutral-border': 'global.color.feedback.neutral.stroke',
    'rgb-status-verified': 'palette.info.300',
    'rgb-text-on-status': 'global.color.iconButton.badge.foreground',
    'rgb-brand-purple': 'palette.violet.300',
    'rgb-syntax-text': 'click.codeblock.darkMode.color.text.default',
    'rgb-syntax-comment': 'global.color.text.muted',
    'rgb-syntax-meta': 'palette.slate.400',
    'rgb-syntax-builtin': 'global.color.chart.default.sunrise',
    'rgb-syntax-keyword': 'palette.info.300',
    'rgb-syntax-string': 'palette.success.300',
    'rgb-syntax-attr': 'global.color.chart.default.fuchsia',
    'rgb-syntax-title': 'global.color.chart.default.orange',
    'rgb-series-1': 'global.color.chart.default.blue',
    'rgb-series-2': 'global.color.chart.default.orange',
    'rgb-series-3': 'global.color.chart.default.green',
    'rgb-series-4': 'global.color.chart.default.fuchsia',
    'rgb-series-5': 'global.color.chart.default.sunrise',
    'rgb-series-6': 'global.color.chart.default.violet',
    'rgb-series-7': 'global.color.chart.default.babyblue',
    'rgb-series-8': 'global.color.chart.default.teal',
    'rgb-switch-unchecked': 'palette.neutral.500',
    'rgb-presentation': 'global.color.background.default',
  },
};

/** Values the theme sets on purpose without a Click UI source, and why. */
const unsourcedColors: Record<ThemeMode, Partial<Record<keyof IThemeRGB, string>>> = {
  light: {},
  dark: {
    'rgb-surface-overlay':
      'Click UI dark dialog.color.opaqueBackground is a gray that leaves the dialog under 3:1',
  },
};

/**
 * Appearance choices that are a reading of Click UI rather than one of its values, and the
 * evidence for each. Click UI gives every disabled control a fixed fill, ink and edge
 * (`button.basic.color.primary.*.disabled`, `field.color.*.disabled`, `global.color.text.disabled`)
 * and never fades one, so the theme paints them instead of dimming.
 */
const appearanceDecisions: Partial<Record<keyof IThemeAppearance, string>> = {
  disabledStyle: 'fill: Click UI paints disabled controls in fixed disabled tokens, never opacity',
  text2xl:
    "1.5rem: Click UI's next size, font.sizes.6 (2rem), would pass Tailwind's unthemed text-3xl (1.875rem)",
};

const appearanceSources: Partial<Record<keyof IThemeAppearance, string>> = {
  controlRadius: 'border.radii.1',
  radiusSm: 'border.radii.1',
  radiusMd: 'border.radii.1',
  radiusLg: 'border.radii.1',
  surfaceRadius: 'border.radii.2',
  radiusXl: 'border.radii.2',
  radius2xl: 'border.radii.2',
  largeSurfaceRadius: 'border.radii.3',
  radius3xl: 'border.radii.3',
  roundControlRadius: 'border.radii.full',
  fontFamily: 'typography.font.families.regular',
  monoFontFamily: 'typography.font.families.mono',
  displayFontFamily: 'typography.font.families.display',
  textXs: 'typography.font.sizes.1',
  textSm: 'typography.font.sizes.2',
  textBase: 'typography.font.sizes.3',
  textLg: 'typography.font.sizes.4',
  textXl: 'typography.font.sizes.5',
  leadingXs: 'typography.font.line-height.1',
  leadingSm: 'typography.font.line-height.1',
  leadingBase: 'typography.font.line-height.1',
  leadingLg: 'typography.font.line-height.1',
  leadingXl: 'typography.font.line-height.1',
  leading2xl: 'typography.font.line-height.1',
  shadow2xs: 'shadow.5',
  shadowXs: 'shadow.5',
  shadowSm: 'shadow.5',
  shadowMd: 'shadow.1',
  shadowLg: 'shadow.1',
  shadowXl: 'shadow.1',
  shadow2xl: 'shadow.1',
  elevationSurface: 'shadow.1',
  controlHeight: 'click.genericMenu.panel.size.height',
  motionFast: 'transition.duration.medium',
  motionNormal: 'transition.duration.smooth',
};

/** Click UI's gray `lch()` stops, converted through CIE L* to an sRGB channel. Chroma must be zero. */
function lchGray(lightness: number): number {
  const y = lightness > 8 ? ((lightness + 16) / 116) ** 3 : lightness / 903.2962962;
  const srgb = y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (1 / 2.4) - 0.055;
  return srgb * 255;
}

function channel(value: string): number {
  return value.endsWith('%') ? (parseFloat(value) / 100) * 255 : Number(value);
}

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (hex) {
    return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16), 1];
  }
  const fn = /^(rgba?|lch)\((.+)\)$/.exec(value.trim());
  if (!fn) {
    throw new Error(`Unsupported Click UI color: ${value}`);
  }
  const [channels, alpha = '1'] = fn[2].split('/').map((part) => part.trim());
  const parts = channels.split(/[\s,]+/).filter(Boolean);
  const a = parts.length === 4 ? Number(parts[3]) : Number(alpha);
  if (fn[1] !== 'lch') {
    return [channel(parts[0]), channel(parts[1]), channel(parts[2]), a];
  }
  if (Number(parts[1]) !== 0) {
    throw new Error(`Only achromatic lch() is supported: ${value}`);
  }
  const gray = lchGray(Number(parts[0]));
  return [gray, gray, gray, a];
}

const formatRgba = ([r, g, b, a]: Rgba) =>
  `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(a.toFixed(3))})`;

/**
 * Click UI writes derived colors as rounded percentages, so a channel can land between two 8-bit
 * values (`98.627%` is 251.5). A theme value within one step of the exact channel is a match.
 */
const sameRgb = (theme: string, source: Rgba) => {
  const channels = theme.split(' ').map(Number);
  return (
    channels.length === 3 &&
    channels.every((value, index) => Number.isFinite(value) && Math.abs(value - source[index]) < 1)
  );
};

/** Every color function in a shadow list, rewritten to one form so both sides compare. */
const normalizeShadow = (value: string) =>
  value
    .replace(/(rgba?|lch)\([^)]*\)/g, (color) => formatRgba(parseColor(color)))
    .replace(/\s+/g, ' ')
    .trim();

const firstFamily = (value: string) => value.split(',')[0].trim();

/** How a Click UI appearance token compares with the theme value that cites it. */
function comparable(key: keyof IThemeAppearance, raw: string | number): string {
  const value = String(raw);
  if (key.startsWith('shadow') || key === 'elevationSurface') {
    return normalizeShadow(value);
  }
  /** Click UI's mono tail names `"SFMono Regular"`, which no platform installs; the theme keeps
   *  the default theme's metric-matched tail, so only the face it leads with is Click UI's. */
  if (key === 'monoFontFamily') {
    return firstFamily(value);
  }
  return value.replace(/;$/, '').trim();
}

describe('ClickHouse theme drift against Click UI', () => {
  it('records the Click UI tag and commit the snapshot was taken from', () => {
    expect(snapshot.source).toBe('https://github.com/ClickHouse/click-ui');
    expect(snapshot.tag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(snapshot.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each(modes)('names a Click UI source for every %s color, or a reason it has none', (mode) => {
    const colors = clickHouseTheme.modes[mode]?.colors ?? {};
    const missing = Object.keys(colors).filter(
      (key) =>
        colorSources[mode][key as keyof IThemeRGB] === undefined &&
        unsourcedColors[mode][key as keyof IThemeRGB] === undefined,
    );
    const stale = [
      ...Object.keys(colorSources[mode]),
      ...Object.keys(unsourcedColors[mode]),
    ].filter((key) => !(key in colors));

    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  it.each(modes)('matches every sourced %s color to its Click UI token', (mode) => {
    const colors = clickHouseTheme.modes[mode]?.colors ?? {};
    const drift = Object.entries(colorSources[mode]).flatMap(([key, token]) => {
      const source = tokens[mode][token];
      if (source === undefined) {
        return [`${key}: Click UI token ${token} is not in clickui.json`];
      }
      const theme = colors[key as keyof IThemeRGB] ?? '';
      return sameRgb(theme, parseColor(String(source)))
        ? []
        : [`${key}: theme ${theme}, Click UI ${token} is ${source}`];
    });

    expect(drift).toEqual([]);
  });

  it.each(modes)('matches every %s shape, font and motion value to its Click UI token', (mode) => {
    const appearance = clickHouseTheme.modes[mode]?.appearance ?? {};
    const unsourced = Object.keys(appearance).filter(
      (key) =>
        appearanceSources[key as keyof IThemeAppearance] === undefined &&
        appearanceDecisions[key as keyof IThemeAppearance] === undefined,
    );
    const drift = Object.entries(appearanceSources).flatMap(([name, token]) => {
      const key = name as keyof IThemeAppearance;
      const source = tokens[mode][token];
      if (source === undefined) {
        return [`${key}: Click UI token ${token} is not in clickui.json`];
      }
      const theme = appearance[key];
      if (theme === undefined) {
        return [`${key}: the theme does not set it, Click UI ${token} is ${source}`];
      }
      return comparable(key, theme) === comparable(key, source)
        ? []
        : [`${key}: theme ${theme}, Click UI ${token} is ${source}`];
    });

    expect({ unsourced, drift }).toEqual({ unsourced: [], drift: [] });
  });

  it.each(modes)('keeps only the %s tokens the theme cites in the snapshot', (mode) => {
    const cited = new Set([
      ...Object.values(colorSources[mode]),
      ...Object.values(appearanceSources),
    ]);

    expect(Object.keys(tokens[mode]).filter((token) => !cited.has(token))).toEqual([]);
  });
});

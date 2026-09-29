import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { IThemeAppearance, IThemeRGB, ThemeMode } from '../types';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/Table';
import { OGDialog, OGDialogContent, OGDialogTitle } from '../../components/OriginalDialog';
import { Button } from '../../components/Button';
import { Switch } from '../../components/Switch';
import Dropdown from '../../components/Dropdown';
import { Input } from '../../components/Input';
import { clickHouseTheme } from './clickhouse';
import Badge from '../../components/Badge';
import { resolveTheme } from '../registry';
import snapshot from './clickui.json';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

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
    'rgb-link-prose': 'palette.info.500',
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
    'rgb-surface-qr': 'palette.neutral.0',
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
    'rgb-switch-thumb': 'click.switch.color.indicator.default',
    'rgb-table-header-text': 'click.table.header.color.title.default',
    'rgb-table-header-fill': 'click.table.header.color.background.default',
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
    'rgb-link-prose': 'global.color.text.link.default',
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
    'rgb-surface-qr': 'palette.neutral.0',
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
    'rgb-switch-thumb': 'click.switch.color.indicator.default',
    'rgb-table-header-text': 'click.table.header.color.title.default',
    'rgb-table-header-fill': 'click.table.header.color.background.default',
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
  scrimOpacity: 'click.dialog.color.opaqueBackground.default',
  alertScrimOpacity: 'click.dialog.color.opaqueBackground.default',
  modalScrimOpacity: 'click.dialog.color.opaqueBackground.default',
  switchWidth: 'click.switch.size.width',
  switchHeight: 'click.switch.size.height',
  tableCellSpaceY: 'click.table.body.cell.space.md.y',
  tableRowStroke: 'click.table.cell.stroke',
  motionFast: 'transition.duration.medium',
  motionNormal: 'transition.duration.smooth',
};

/** Click UI's gray `lch()` stops, converted through CIE L* to an sRGB channel. Chroma must be zero. */
function lchGray(lightness: number): number {
  const y = lightness > 8 ? ((lightness + 16) / 116) ** 3 : lightness / 903.2962962;
  const srgb = y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (1 / 2.4) - 0.055;
  return srgb * 255;
}

/**
 * A chromatic CSS `lch()` (D50) converted to sRGB channels: Lab to XYZ, Bradford to D65, then the
 * sRGB matrix and transfer curve. Click UI writes a few component colors this way, such as the
 * light dialog title.
 */
function lchColor(lightness: number, chroma: number, hue: number): [number, number, number] {
  const radians = (hue * Math.PI) / 180;
  const fy = (lightness + 16) / 116;
  const fx = fy + (chroma * Math.cos(radians)) / 500;
  const fz = fy - (chroma * Math.sin(radians)) / 200;
  const epsilon = 216 / 24389;
  const kappa = 24389 / 27;
  const inverse = (t: number) => (t ** 3 > epsilon ? t ** 3 : (116 * t - 16) / kappa);
  const x50 = 0.96422 * inverse(fx);
  const y50 = lightness > kappa * epsilon ? fy ** 3 : lightness / kappa;
  const z50 = 0.82521 * inverse(fz);
  const x = 0.9554734527 * x50 - 0.0230985369 * y50 + 0.0632593087 * z50;
  const y = -0.028369707 * x50 + 1.009995458 * y50 + 0.021041399 * z50;
  const z = 0.0123140017 * x50 - 0.0205076964 * y50 + 1.3303659366 * z50;
  const linear = [
    3.2409699419 * x - 1.5373831776 * y - 0.4986107603 * z,
    -0.9692436363 * x + 1.8759675015 * y + 0.0415550574 * z,
    0.0556300797 * x - 0.2039769589 * y + 1.0569715142 * z,
  ];
  const [r, g, b] = linear.map(
    (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055),
  );
  return [r, g, b];
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
    return [...lchColor(Number(parts[0]), Number(parts[1]), Number(parts[2])), a];
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
const scrimKeys: ReadonlySet<keyof IThemeAppearance> = new Set([
  'scrimOpacity',
  'alertScrimOpacity',
  'modalScrimOpacity',
]);

function comparable(key: keyof IThemeAppearance, raw: string | number): string {
  const value = String(raw);
  /** A scrim role is the alpha of Click UI's scrim color; the color itself is `surface-overlay`. */
  if (scrimKeys.has(key)) {
    return /^[\d.]+$/.test(value) ? String(Number(value)) : String(parseColor(value)[3]);
  }
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

/**
 * Color and shape parity of the shared primitives against Click UI's own components. Each probe
 * renders a primitive, reads the utility it paints for one decision (`bg-*`, `text-*`, a
 * `border-*` color on an element that draws a border, `rounded-*`), resolves that role under the
 * ClickHouse theme, and compares it with the Click UI component token. A primitive that paints
 * nothing for a decision reads as transparent, no border or square, and text with no color of its
 * own inherits the body copy (`text-primary`).
 *
 * The score is how many decisions match, per mode. Run with `CLICKUI_PARITY_REPORT=1` to print
 * every decision; the floors below only move up.
 */
type ParityKind = 'color' | 'shape';
type Utility = 'bg' | 'text' | 'border' | 'rounded' | 'w' | 'h' | 'py';

interface ParityProbe {
  /** The Click UI component token the primitive should reproduce. */
  token: string;
  kind: ParityKind;
  utility: Utility;
  /** A state the utility is written under, such as `data-[state=checked]:`. */
  variant?: string;
  /** Renders the primitive and returns the element that paints the decision. */
  element: () => Element;
  /** Why the theme departs from Click UI on purpose, when it does. */
  deviation?: string;
}

function mount(tree: ReactElement, selector: string): Element {
  const { baseElement } = render(tree);
  const element = baseElement.querySelector(selector);
  if (!element) {
    throw new Error(`Parity probe found no ${selector}`);
  }
  return element;
}

const switchProbe = (checked: boolean) => () =>
  mount(createElement(Switch, { 'aria-label': 'probe', checked }), '[role="switch"]');

const tableProbe = (selector: string) => () =>
  mount(
    createElement(
      Table,
      null,
      createElement(
        TableHeader,
        null,
        createElement(TableRow, null, createElement(TableHead, null, 'Name')),
      ),
      createElement(
        TableBody,
        null,
        createElement(TableRow, null, createElement(TableCell, null, 'Row')),
      ),
    ),
    selector,
  );

const dialogProbe = (selector: string) => () =>
  mount(
    createElement(
      OGDialog,
      { open: true },
      createElement(OGDialogContent, null, createElement(OGDialogTitle, null, 'Title')),
    ),
    selector,
  );

const badgeProbe = () =>
  mount(createElement(Badge, { label: 'Tools', isAvailable: true }), 'button');

const inputProbe = () => mount(createElement(Input, { 'aria-label': 'probe' }), 'input');

const dropdownProbe = () =>
  mount(
    createElement(Dropdown, {
      value: 'a',
      options: [{ value: 'a', label: 'A' }],
      ariaLabel: 'probe',
      onChange: () => undefined,
    }),
    '[role="combobox"]',
  );

const buttonProbe = (variant: 'default' | 'outline') => () =>
  mount(createElement(Button, { variant }, 'Save'), 'button');

const parityProbes: Record<string, ParityProbe> = {
  'Button primary fill': {
    token: 'click.button.basic.color.primary.background.default',
    kind: 'color',
    utility: 'bg',
    element: buttonProbe('default'),
  },
  'Button primary label': {
    token: 'click.button.basic.color.primary.text.default',
    kind: 'color',
    utility: 'text',
    element: buttonProbe('default'),
  },
  'Button secondary stroke': {
    token: 'click.button.basic.color.secondary.stroke.default',
    kind: 'color',
    utility: 'border',
    element: buttonProbe('outline'),
  },
  'Button corner': {
    token: 'border.radii.1',
    kind: 'shape',
    utility: 'rounded',
    element: buttonProbe('default'),
  },
  'Field fill': {
    token: 'click.field.color.background.default',
    kind: 'color',
    utility: 'bg',
    element: inputProbe,
  },
  'Field stroke': {
    token: 'click.field.color.stroke.default',
    kind: 'color',
    utility: 'border',
    element: inputProbe,
    deviation: 'border-control holds form controls to the 3:1 non-text floor stroke.default misses',
  },
  'Field text': {
    token: 'click.field.color.text.default',
    kind: 'color',
    utility: 'text',
    element: inputProbe,
  },
  'Field corner': {
    token: 'border.radii.1',
    kind: 'shape',
    utility: 'rounded',
    element: inputProbe,
  },
  'Dropdown trigger stroke': {
    token: 'click.field.color.stroke.default',
    kind: 'color',
    utility: 'border',
    element: dropdownProbe,
    deviation: 'border-control holds form controls to the 3:1 non-text floor stroke.default misses',
  },
  'Dropdown trigger corner': {
    token: 'border.radii.1',
    kind: 'shape',
    utility: 'rounded',
    element: dropdownProbe,
  },
  'Dialog surface': {
    token: 'click.dialog.color.background.default',
    kind: 'color',
    utility: 'bg',
    element: dialogProbe('[role="dialog"]'),
  },
  'Dialog stroke': {
    token: 'click.dialog.stroke.default',
    kind: 'color',
    utility: 'border',
    element: dialogProbe('[role="dialog"]'),
  },
  'Dialog title': {
    token: 'click.dialog.color.title.default',
    kind: 'color',
    utility: 'text',
    element: dialogProbe('h2'),
  },
  'Dialog scrim': {
    token: 'click.dialog.color.opaqueBackground.default',
    kind: 'color',
    utility: 'bg',
    element: dialogProbe('.inset-0'),
  },
  'Dialog corner': {
    token: 'click.dialog.radii.all',
    kind: 'shape',
    utility: 'rounded',
    element: dialogProbe('[role="dialog"]'),
  },
  'Switch track, on': {
    token: 'click.switch.color.background.active',
    kind: 'color',
    utility: 'bg',
    variant: 'data-[state=checked]:',
    element: switchProbe(true),
  },
  'Switch track, off': {
    token: 'click.switch.color.background.default',
    kind: 'color',
    utility: 'bg',
    variant: 'data-[state=unchecked]:',
    element: switchProbe(false),
    deviation: 'switch-unchecked holds the off track to the 3:1 non-text floor #cccfd3 misses',
  },
  'Switch thumb': {
    token: 'click.switch.color.indicator.default',
    kind: 'color',
    utility: 'bg',
    element: () => switchProbe(false)().firstElementChild ?? document.body,
  },
  'Switch width': {
    token: 'click.switch.size.width',
    kind: 'shape',
    utility: 'w',
    element: switchProbe(false),
  },
  'Switch height': {
    token: 'click.switch.size.height',
    kind: 'shape',
    utility: 'h',
    element: switchProbe(false),
  },
  'Switch corner': {
    token: 'click.switch.radii.all',
    kind: 'shape',
    utility: 'rounded',
    element: switchProbe(false),
  },
  'Table header fill': {
    token: 'click.table.header.color.background.default',
    kind: 'color',
    utility: 'bg',
    element: tableProbe('thead'),
  },
  'Table header title': {
    token: 'click.table.header.color.title.default',
    kind: 'color',
    utility: 'text',
    element: tableProbe('th'),
  },
  'Table row stroke': {
    token: 'click.table.row.color.stroke.default',
    kind: 'color',
    utility: 'border',
    element: tableProbe('td'),
  },
  'Table cell space': {
    token: 'click.table.body.cell.space.md.y',
    kind: 'shape',
    utility: 'py',
    element: tableProbe('td'),
  },
  'Table compact cell space': {
    token: 'click.table.body.cell.space.sm.y',
    kind: 'shape',
    utility: 'py',
    variant: 'sm:',
    element: () =>
      mount(
        createElement(
          Table,
          null,
          createElement(
            TableBody,
            null,
            createElement(TableRow, null, createElement(TableCell, { size: 'compact' }, 'Row')),
          ),
        ),
        'td',
      ),
  },
  'Table corner': {
    token: 'click.table.radii.all',
    kind: 'shape',
    utility: 'rounded',
    element: tableProbe('div'),
    deviation: 'the table has no frame of its own; each consumer draws the panel it sits in',
  },
  'Badge fill': {
    token: 'click.badge.opaque.color.background.default',
    kind: 'color',
    utility: 'bg',
    element: badgeProbe,
  },
  'Badge label': {
    token: 'click.badge.opaque.color.text.default',
    kind: 'color',
    utility: 'text',
    element: badgeProbe,
  },
  'Badge stroke': {
    token: 'click.badge.opaque.color.stroke.default',
    kind: 'color',
    utility: 'border',
    element: badgeProbe,
  },
  'Badge corner': {
    token: 'click.badge.radii.all',
    kind: 'shape',
    utility: 'rounded',
    element: badgeProbe,
  },
};

/** The fewest decisions per mode that must match; raise a floor when a change closes a gap. */
const parityFloors: Record<ThemeMode, Record<ParityKind, number>> = {
  light: { color: 9, shape: 10 },
  dark: { color: 10, shape: 10 },
};

const radiusRoles: Record<string, keyof IThemeAppearance> = {
  sm: 'radiusSm',
  md: 'radiusMd',
  lg: 'radiusLg',
  xl: 'radiusXl',
  '2xl': 'radius2xl',
  '3xl': 'radius3xl',
  'theme-control': 'controlRadius',
  'theme-control-round': 'roundControlRadius',
  'theme-surface': 'surfaceRadius',
  'theme-surface-lg': 'largeSurfaceRadius',
};

const fixedRadii: Record<string, string> = { full: '9999px', none: '0px' };

type SizeUtility = 'w' | 'h' | 'py';

const sizeRoles: Record<SizeUtility, Record<string, keyof IThemeAppearance>> = {
  w: { 'theme-switch': 'switchWidth' },
  h: { 'theme-switch': 'switchHeight', 'theme-control': 'controlHeight' },
  py: { 'theme-table-cell': 'tableCellSpaceY' },
};

/** The compact and dense table sizes divide the cell space, as the preset does. */
const derivedSizes: Record<string, [keyof IThemeAppearance, number]> = {
  'theme-table-cell-compact': ['tableCellSpaceY', 2],
  'theme-table-cell-dense': ['tableCellSpaceY', 4],
};

const isSizeUtility = (utility: Utility): utility is SizeUtility =>
  utility === 'w' || utility === 'h' || utility === 'py';

/** A `border`, `border-2` or one-sided `border-b` class, or a theme stroke role that is not
 *  zero: the width a border color needs to show. */
const drawsBorder = (classes: string[], resolved: Resolved) =>
  classes.some(
    (name) =>
      /^border(-[0-9]+|-[xytblrse](-[0-9]+)?)?$/.test(name) ||
      (/^border(-[xytblrse])?-\(length:--theme-table-row-stroke\)$/.test(name) &&
        parseFloat(resolved.appearance.tableRowStroke) > 0),
  );

type Resolved = ReturnType<typeof resolveTheme>;

/** A `w-*`, `h-*` or `py-*` step: a theme role, or Tailwind's 0.25rem spacing scale. */
function sizeValue(utility: SizeUtility, name: string, resolved: Resolved): string | undefined {
  const role = sizeRoles[utility][name];
  if (role !== undefined) {
    return resolved.appearance[role];
  }
  const derived = utility === 'py' ? derivedSizes[name] : undefined;
  if (derived !== undefined) {
    const [source, divisor] = derived;
    const value = resolved.appearance[source];
    return `${parseFloat(value) / divisor}${value.replace(/^[\d.]+/, '')}`;
  }
  return /^[0-9.]+$/.test(name) ? `${Number(name) / 4}rem` : undefined;
}

function roleColor(resolved: Resolved, name: string): Rgba | undefined {
  const [role, alpha] = name.split('/');
  if (role === 'transparent') {
    return [0, 0, 0, 0];
  }
  const triplet = resolved.colors[`rgb-${role}` as keyof IThemeRGB];
  if (triplet === undefined) {
    return undefined;
  }
  const [r, g, b] = triplet.split(' ').map(Number);
  return [r, g, b, alpha === undefined ? 1 : Number(alpha) / 100];
}

/** The role a probe paints, or `undefined` when the primitive paints nothing for it. */
function paintedRole(element: Element, probe: ParityProbe, resolved: Resolved): string | undefined {
  const prefix = `${probe.variant ?? ''}${probe.utility}-`;
  const classes = (element.getAttribute('class') ?? '').split(/\s+/);
  const names = classes
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length));
  if (probe.utility === 'rounded') {
    return names.find((name) => name in radiusRoles || name in fixedRadii);
  }
  if (isSizeUtility(probe.utility)) {
    const utility = probe.utility;
    /** `p-4` pads every side, so it answers a `py` probe too. */
    const padding = utility === 'py' ? classes.filter((name) => /^p-[0-9.]+$/.test(name)) : [];
    return [...names, ...padding.map((name) => name.slice(2))].find(
      (name) => sizeValue(utility, name, resolved) !== undefined,
    );
  }
  if (probe.utility === 'border' && !drawsBorder(classes, resolved)) {
    return undefined;
  }
  return names.find((name) => roleColor(resolved, name) !== undefined);
}

function inheritedTextRole(element: Element, probe: ParityProbe, resolved: Resolved): string {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const role = paintedRole(node, probe, resolved);
    if (role !== undefined) {
      return role;
    }
  }
  return 'text-primary';
}

const clickColor = (value: string): Rgba =>
  parseColor(/(#[0-9a-f]{6}|(?:rgba?|lch)\([^)]*\))\s*;?$/i.exec(value.trim())?.[1] ?? value);

const sameColor = (a: Rgba, b: Rgba) =>
  (a[3] === 0 && b[3] === 0) ||
  (a.slice(0, 3).every((value, index) => Math.abs(value - b[index]) < 1) &&
    Math.abs(a[3] - b[3]) < 0.01);

function shapeValue(utility: Utility, role: string | undefined, resolved: Resolved): string {
  if (role === undefined) {
    return utility === 'rounded' ? '0px' : 'auto';
  }
  if (isSizeUtility(utility)) {
    return sizeValue(utility, role, resolved) ?? 'auto';
  }
  return fixedRadii[role] ?? resolved.appearance[radiusRoles[role]];
}

interface ParityResult {
  decision: string;
  kind: ParityKind;
  match: boolean;
  theme: string;
  clickUi: string;
  deviation?: string;
}

function measure(mode: ThemeMode, decision: string, probe: ParityProbe): ParityResult {
  const resolved = resolveTheme(clickHouseTheme, mode);
  const element = probe.element();
  const source = tokens[mode][probe.token];
  const role =
    probe.utility === 'text'
      ? inheritedTextRole(element, probe, resolved)
      : paintedRole(element, probe, resolved);
  cleanup();
  const base = { decision, kind: probe.kind, clickUi: source, deviation: probe.deviation };
  if (probe.kind === 'shape') {
    const theme = shapeValue(probe.utility, role, resolved);
    const painted = role === undefined ? 'unpainted' : `${probe.utility}-${role}`;
    return { ...base, theme: `${painted} = ${theme}`, match: theme === source };
  }
  const color = role === undefined ? ([0, 0, 0, 0] as Rgba) : roleColor(resolved, role);
  const painted = role === undefined ? 'unpainted' : `${probe.utility}-${role}`;
  const theme = `${painted} = ${color ? formatRgba(color) : 'unresolved'}`;
  return { ...base, theme, match: color !== undefined && sameColor(color, clickColor(source)) };
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
      ...Object.values(parityProbes).map((probe) => probe.token),
    ]);

    expect(Object.keys(tokens[mode]).filter((token) => !cited.has(token))).toEqual([]);
  });
});

describe('ClickHouse primitive parity against Click UI components', () => {
  it.each(modes)('matches at least the recorded number of %s decisions', (mode) => {
    const results = Object.entries(parityProbes).map(([decision, probe]) =>
      measure(mode, decision, probe),
    );
    const score = (kind: ParityKind) => {
      const scoped = results.filter((result) => result.kind === kind);
      const matched = scoped.filter((result) => result.match).length;
      return { matched, total: scoped.length };
    };
    const color = score('color');
    const shape = score('shape');

    if (process.env.CLICKUI_PARITY_REPORT) {
      const verdict = ({ match, deviation }: ParityResult) => {
        if (match) {
          return 'match';
        }
        return deviation ? 'deviation' : 'gap';
      };
      const rows = results.map(
        (result) => `${verdict(result)}\t${result.decision}\t${result.theme}\t${result.clickUi}`,
      );
      const percent = ({ matched, total }: { matched: number; total: number }) =>
        `${matched}/${total} (${((matched / total) * 100).toFixed(1)}%)`;
      console.info(
        [`${mode}: color ${percent(color)}, shape ${percent(shape)}`, ...rows].join('\n'),
      );
    }

    expect(color.matched).toBeGreaterThanOrEqual(parityFloors[mode].color);
    expect(shape.matched).toBeGreaterThanOrEqual(parityFloors[mode].shape);
  });
});

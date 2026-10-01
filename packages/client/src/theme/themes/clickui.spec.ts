import { createElement } from 'react';
import { join } from 'path';
import { readFileSync } from 'fs';
import { cleanup, fireEvent, render } from '@testing-library/react';
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
import { resolveTheme, themeAppearanceProperties } from '../registry';
import { Tabs, TabsList, TabsTrigger } from '../../components/Tabs';
import { Button } from '../../components/Button';
import { Switch } from '../../components/Switch';
import Dropdown from '../../components/Dropdown';
import { Input } from '../../components/Input';
import { clickHouseTheme } from './clickhouse';
import Badge from '../../components/Badge';
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

/** A cited Click UI token, failing by name when the snapshot no longer carries it. */
function clickToken(mode: ThemeMode, token: string): string {
  const value = tokens[mode][token];
  if (value === undefined) {
    throw new Error(`Click UI token ${token} is not in the ${mode} snapshot`);
  }
  return String(value);
}
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
    'rgb-dialog-title': 'click.dialog.color.title.default',
    'rgb-badge-label': 'click.badge.opaque.color.text.default',
    'rgb-surface-overlay': 'click.dialog.color.opaqueBackground.default',
    'rgb-surface-submit': 'global.color.accent.default',
    'rgb-surface-submit-hover': 'palette.neutral.712',
    'rgb-surface-destructive': 'palette.danger.600',
    'rgb-surface-destructive-hover': 'palette.danger.700',
    'rgb-surface-chat': 'global.color.background.default',
    'rgb-surface-code': 'click.codeblock.lightMode.color.background.default',
    'rgb-surface-code-body': 'click.codeblock.lightMode.color.background.default',
    'rgb-surface-qr': 'palette.neutral.0',
    'rgb-text-on-media': 'palette.neutral.0',
    'rgb-surface-inverted': 'palette.neutral.900',
    'rgb-surface-inverted-hover': 'palette.neutral.712',
    'rgb-surface-inverted-pressed': 'click.button.basic.color.primary.background.active',
    'rgb-button-primary': 'click.button.basic.color.primary.background.default',
    'rgb-button-primary-hover': 'click.button.basic.color.primary.background.hover',
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
    'rgb-border-field-focus': 'click.field.color.stroke.active',
    'rgb-field-fill': 'click.field.color.background.default',
    'rgb-field-text': 'click.field.color.text.default',
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
    'rgb-avatar-fill': 'click.avatar.color.background.default',
    'rgb-avatar-text': 'click.avatar.color.text.default',
    'rgb-avatar-placeholder': 'global.color.background.muted',
    'rgb-illustration-subtle': 'palette.info.200',
    'rgb-illustration': 'palette.info.400',
    'rgb-illustration-strong': 'palette.info.600',
    'rgb-file-document': 'palette.fuchsia.600',
    'rgb-file-sheet': 'palette.success.700',
    'rgb-file-code': 'palette.warning.600',
    'rgb-file-artifact': 'palette.slate.800',
    'rgb-file-audio': 'palette.sunrise.700',
    'rgb-file-video': 'palette.violet.600',
    'rgb-file-generic': 'palette.info.600',
    'rgb-file-ink': 'palette.neutral.0',
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
    'rgb-dialog-title': 'click.dialog.color.title.default',
    'rgb-badge-label': 'click.badge.opaque.color.text.default',
    'rgb-surface-submit': 'global.color.accent.default',
    'rgb-surface-submit-hover': 'palette.brand.200',
    'rgb-surface-destructive': 'palette.danger.300',
    'rgb-surface-destructive-hover': 'palette.danger.200',
    'rgb-surface-chat': 'global.color.background.default',
    'rgb-surface-code': 'click.codeblock.darkMode.color.background.default',
    'rgb-surface-code-body': 'click.codeblock.darkMode.color.background.default',
    'rgb-surface-qr': 'palette.neutral.0',
    'rgb-text-on-media': 'palette.neutral.0',
    'rgb-surface-inverted': 'click.button.basic.color.primary.background.default',
    'rgb-surface-inverted-hover': 'click.button.basic.color.primary.background.hover',
    'rgb-surface-inverted-pressed': 'click.button.basic.color.primary.background.active',
    'rgb-button-primary': 'click.button.basic.color.primary.background.default',
    'rgb-button-primary-hover': 'click.button.basic.color.primary.background.hover',
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
    'rgb-border-field-focus': 'click.field.color.stroke.active',
    'rgb-field-fill': 'click.field.color.background.default',
    'rgb-field-text': 'click.field.color.text.default',
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
    'rgb-avatar-fill': 'click.avatar.color.background.default',
    'rgb-avatar-text': 'click.avatar.color.text.default',
    'rgb-avatar-placeholder': 'global.color.background.muted',
    'rgb-illustration-subtle': 'palette.info.200',
    'rgb-illustration': 'palette.info.400',
    'rgb-illustration-strong': 'palette.info.600',
    'rgb-file-document': 'palette.fuchsia.600',
    'rgb-file-sheet': 'palette.success.700',
    'rgb-file-code': 'palette.warning.600',
    'rgb-file-artifact': 'palette.slate.800',
    'rgb-file-audio': 'palette.sunrise.700',
    'rgb-file-video': 'palette.violet.600',
    'rgb-file-generic': 'palette.info.600',
    'rgb-file-ink': 'palette.neutral.0',
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

/** Click UI has no scrim for media; a lightbox or preview frames the user's image in black. */
const MEDIA_OVERLAY_REASON =
  'Click UI has no media scrim; the image frame stays black in both modes';
const AVATAR_EDGE_REASON =
  'Click UI avatars draw no edge; the theme keeps the 10% hairline every LibreChat avatar has';
const MEDIA_SCRIM_DEPARTURE =
  'the dialog scrim is the nearest Click UI job; a lightbox frames the user image in black instead';

/** Values the theme sets on purpose without a Click UI source, and why. */
const unsourcedColors: Record<ThemeMode, Partial<Record<keyof IThemeRGB, string>>> = {
  light: {
    'rgb-surface-media-overlay': MEDIA_OVERLAY_REASON,
    'rgb-avatar-edge': AVATAR_EDGE_REASON,
  },
  dark: {
    'rgb-surface-overlay':
      'Click UI dark dialog.color.opaqueBackground is a gray that leaves the dialog under 3:1',
    'rgb-surface-media-overlay': MEDIA_OVERLAY_REASON,
    'rgb-avatar-edge': AVATAR_EDGE_REASON,
  },
};

/**
 * How close a role lands on Click UI: `match` holds the token that names the role's job, `near` is
 * within deltaE2000 5 of it, and `mismatch` is further off.
 */
type RoleStatus = 'match' | 'near' | 'mismatch';

interface Departure {
  /** The Click UI token that names the role's job, which the theme's value departs from. */
  counterpart: string;
  status: Exclude<RoleStatus, 'match'>;
  reason: string;
}

/**
 * Roles whose value is not the Click UI token that names the same job, and why. Each one cites a
 * step on the same Click UI ramp in `colorSources`; the status pins how far that step sits from
 * the counterpart. Every other role holds its counterpart, so its status is `match`.
 */
const departures: Record<ThemeMode, Partial<Record<keyof IThemeRGB, Departure>>> = {
  light: {
    'rgb-avatar-edge': {
      counterpart: 'global.color.stroke.default',
      status: 'near',
      reason: AVATAR_EDGE_REASON,
    },
    'rgb-surface-media-overlay': {
      counterpart: 'click.dialog.color.opaqueBackground.default',
      status: 'near',
      reason: MEDIA_SCRIM_DEPARTURE,
    },
    'rgb-text-secondary': {
      counterpart: 'global.color.text.muted',
      status: 'mismatch',
      reason: 'text.muted is 4.05:1 on feedback.danger.background, where secondary copy also sits',
    },
    'rgb-text-secondary-alt': {
      counterpart: 'global.color.text.muted',
      status: 'mismatch',
      reason: 'text.muted is 4.05:1 on feedback.danger.background, where secondary copy also sits',
    },
    'rgb-text-tertiary': {
      counterpart: 'global.color.text.muted',
      status: 'mismatch',
      reason: 'text.muted is 4.05:1 on feedback.danger.background, where secondary copy also sits',
    },
    'rgb-link': {
      counterpart: 'global.color.text.link.default',
      status: 'mismatch',
      reason: 'text.link.default is 3.84:1 on white',
    },
    'rgb-link-prose': {
      counterpart: 'global.color.text.link.default',
      status: 'mismatch',
      reason: 'text.link.default is 3.84:1 on white',
    },
    'rgb-border-xheavy': {
      counterpart: 'global.color.stroke.intense',
      status: 'mismatch',
      reason: 'stroke.intense is 2.03:1 on white, under the 3:1 a heavy edge carries',
    },
    'rgb-border-control': {
      counterpart: 'click.field.color.stroke.default',
      status: 'mismatch',
      reason: 'field.color.stroke.default misses the 3:1 non-text floor for a control edge',
    },
    'rgb-status-success': {
      counterpart: 'global.color.feedback.success.foreground',
      status: 'mismatch',
      reason: 'feedback.success.foreground is 4.27:1 on its own fill',
    },
    'rgb-status-info': {
      counterpart: 'global.color.feedback.info.foreground',
      status: 'mismatch',
      reason: 'feedback.info.foreground is 3.32:1 on its own fill',
    },
    'rgb-series-2': {
      counterpart: 'global.color.chart.default.orange',
      status: 'mismatch',
      reason: 'chart.default.orange is 2.65:1 on white, under the 3:1 a chart mark needs',
    },
    'rgb-series-3': {
      counterpart: 'global.color.chart.default.green',
      status: 'mismatch',
      reason: 'chart.default.green is 1.72:1 on white, under the 3:1 a chart mark needs',
    },
    'rgb-series-5': {
      counterpart: 'global.color.chart.default.yellow',
      status: 'mismatch',
      reason: 'chart.default.yellow is 1.19:1 on white, under the 3:1 a chart mark needs',
    },
    'rgb-series-7': {
      counterpart: 'global.color.chart.default.babyblue',
      status: 'mismatch',
      reason: 'chart.default.babyblue is 1.95:1 on white, under the 3:1 a chart mark needs',
    },
    'rgb-switch-unchecked': {
      counterpart: 'click.switch.color.background.default',
      status: 'mismatch',
      reason: 'switch.color.background.default misses the 3:1 non-text floor for the off track',
    },
  },
  dark: {
    'rgb-border-xheavy': {
      counterpart: 'global.color.stroke.intense',
      status: 'mismatch',
      reason: 'stroke.intense is 1.62:1 on the canvas, under the 3:1 a heavy edge carries',
    },
    'rgb-border-control': {
      counterpart: 'click.field.color.stroke.default',
      status: 'mismatch',
      reason: 'field.color.stroke.default misses the 3:1 non-text floor for a control edge',
    },
    'rgb-switch-unchecked': {
      counterpart: 'click.switch.color.background.default',
      status: 'mismatch',
      reason: 'switch.color.background.default misses the 3:1 non-text floor for the off track',
    },
    'rgb-surface-overlay': {
      counterpart: 'click.dialog.color.opaqueBackground.default',
      status: 'mismatch',
      reason: 'the dark scrim is a #606060 gray that lifts the page instead of dimming it',
    },
    'rgb-surface-media-overlay': {
      counterpart: 'click.dialog.color.opaqueBackground.default',
      status: 'mismatch',
      reason: MEDIA_SCRIM_DEPARTURE,
    },
    'rgb-avatar-edge': {
      counterpart: 'global.color.stroke.default',
      status: 'mismatch',
      reason: AVATAR_EDGE_REASON,
    },
  },
};

interface AppearanceDecision {
  /** The value the decision was made for; a theme that moves it has to revisit the decision. */
  value: string;
  /** The Click UI token the decision departs from, when it departs from one. */
  token?: string;
  status: RoleStatus;
  reason: string;
}

/**
 * Appearance choices that are a reading of Click UI rather than one of its values, and the
 * evidence for each. Click UI gives every disabled control a fixed fill, ink and edge
 * (`button.basic.color.primary.*.disabled`, `field.color.*.disabled`, `global.color.text.disabled`)
 * and never fades one, so the theme paints them instead of dimming.
 */
const appearanceDecisions: Partial<Record<keyof IThemeAppearance, AppearanceDecision>> = {
  disabledStyle: {
    value: 'fill',
    status: 'match',
    reason: 'fill: Click UI paints disabled controls in fixed disabled tokens, never opacity',
  },
  text2xl: {
    value: '1.5rem',
    token: 'typography.font.sizes.6',
    status: 'mismatch',
    reason:
      "1.5rem: Click UI's next size, font.sizes.6 (2rem), would pass Tailwind's unthemed text-3xl (1.875rem)",
  },
  buttonHeight: {
    value: '2rem',
    status: 'match',
    reason:
      '2rem: Click UI sizes its button by content, button.basic.space.y (0.2813rem) twice, a 0.875rem/1.5 label and a 1px stroke each side',
  },
  buttonHeightSm: {
    value: '2rem',
    status: 'match',
    reason: '2rem: Click UI draws one button size, so the small step matches the default',
  },
  buttonHeightCompact: {
    value: '2rem',
    status: 'match',
    reason: '2rem: Click UI draws one button size, so the compact step matches the default',
  },
  buttonHeightLg: {
    value: '2rem',
    status: 'match',
    reason: '2rem: Click UI draws one button size, so the large step matches the default',
  },
  tabMinWidth: {
    value: '0',
    status: 'match',
    reason: '0: Click UI sizes tab triggers by their label in tabs.space.x, with no minimum width',
  },
  iconButtonSizeSm: {
    value: '1.5rem',
    status: 'match',
    reason:
      '1.5rem: Click UI IconButton sm is a 1rem icon (iconButton.size.medium) in iconButton.sm.space 0.25rem on each side',
  },
  fieldHeight: {
    value: '2rem',
    status: 'match',
    reason:
      '2rem: Click UI sizes its field by content, field.space.y (0.2813rem) twice, a 0.875rem/1.5 value and a 1px stroke each side',
  },
  fieldFocusStyle: {
    value: 'border',
    status: 'match',
    reason:
      'border: Click UI InputWrapper swaps the stroke to field.color.stroke.active on focus; keyboard focus adds a 1px ring in that color to hold the 2px focus floor',
  },
  tooltipShadow: {
    value: 'none',
    status: 'match',
    reason:
      'none: Click UI Tooltip.module.css draws its tooltip with no shadow; no token carries it',
  },
  fieldFillStyle: {
    value: 'fill',
    status: 'match',
    reason:
      'fill: Click UI InputWrapper paints every field in field.color.background.default; LibreChat fields stay clear by default',
  },
  focusRingWidth: {
    value: '2px',
    status: 'match',
    reason:
      '2px: Click UI draws keyboard focus as a literal `outline: 2px solid` in outline.default (BaseButton, IconButton, Dropdown and ContextMenu triggers); no token carries the width',
  },
  focusRingOffset: {
    value: '2px',
    status: 'match',
    reason:
      '2px: the same Click UI focus rules set a literal `outline-offset: 2px`; no token carries the offset',
  },
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
  spaceCompact: 'spaces.2',
  spaceNormal: 'spaces.3',
  menuRadius: 'click.genericMenu.panel.radii.all',
  tooltipRadius: 'click.tooltip.radii.all',
  tabRadius: 'click.tabs.radii.all',
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
  menuShadow: 'click.genericMenu.panel.shadow.default',
  elevationDrag: 'shadow.1',
  controlHeight: 'click.genericMenu.panel.size.height',
  controlPaddingX: 'click.button.basic.space.x',
  controlGap: 'click.button.basic.space.gap',
  controlFontWeight: 'click.button.basic.typography.label.default',
  dialogStroke: 'click.dialog.stroke.default',
  dialogPaddingX: 'click.dialog.space.x',
  dialogHeaderGap: 'click.dialog.title.space.gap',
  dialogTitleSize: 'click.dialog.typography.title.default',
  dialogTitleLeading: 'click.dialog.typography.title.default',
  dialogTitleFontWeight: 'click.dialog.typography.title.default',
  dialogTitleFontFamily: 'click.dialog.typography.title.default',
  fieldPaddingY: 'click.field.space.y',
  labelSize: 'click.field.typography.label.default',
  labelLeading: 'click.field.typography.label.default',
  labelFontWeight: 'click.field.typography.label.default',
  scrimOpacity: 'click.dialog.color.opaqueBackground.default',
  alertScrimOpacity: 'click.dialog.color.opaqueBackground.default',
  modalScrimOpacity: 'click.dialog.color.opaqueBackground.default',
  switchWidth: 'click.switch.size.width',
  switchHeight: 'click.switch.size.height',
  checkboxSize: 'click.checkbox.size.all',
  iconSize: 'click.image.sm.size.width',
  iconSizeMd: 'click.image.md.size.width',
  iconSizeLg: 'click.image.lg.size.width',
  tableCellSpaceY: 'click.table.body.cell.space.md.y',
  tableRowStroke: 'click.table.cell.stroke',
  motionFast: 'transition.duration.medium',
  motionNormal: 'transition.duration.smooth',
};

/**
 * Click UI's spacing scale, each step with the LibreChat surface that draws it: a spacing role
 * the theme sets, or the Tailwind spacing step of the same size, which every theme shares and
 * `tailwind.spec.js` checks against the compiled stylesheet.
 */
const clickSpaces: Record<string, keyof IThemeAppearance | `p-${number}`> = {
  'spaces.0': 'p-0',
  'spaces.1': 'p-1',
  'spaces.2': 'spaceCompact',
  'spaces.3': 'spaceNormal',
  'spaces.4': 'p-4',
  'spaces.5': 'p-6',
  'spaces.6': 'p-8',
  'spaces.7': 'p-10',
  'spaces.8': 'p-16',
};

/** A length in rem, for a value written in rem or as a bare `0`. */
const remOf = (value: string) => (value.trim() === '0' ? 0 : parseFloat(value));

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

/** sRGB channels to CIE L*a*b* under D65. */
function toLab([r, g, b]: Rgba): [number, number, number] {
  const linear = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047);
  const y = f(0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb);
  const z = f((0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIEDE2000 color difference; under 5 reads as the same color at a glance. */
function deltaE(first: Rgba, second: Rgba): number {
  const [l1, a1, b1] = toLab(first);
  const [l2, a2, b2] = toLab(second);
  const rad = Math.PI / 180;
  const chromaMean = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(chromaMean ** 7 / (chromaMean ** 7 + 25 ** 7)));
  const c1 = Math.hypot(a1 * (1 + g), b1);
  const c2 = Math.hypot(a2 * (1 + g), b2);
  const hue = (b: number, a: number) => (((Math.atan2(b, a) / rad) % 360) + 360) % 360;
  const h1 = c1 === 0 ? 0 : hue(b1, a1 * (1 + g));
  const h2 = c2 === 0 ? 0 : hue(b2, a2 * (1 + g));
  const hueStep = c1 * c2 === 0 ? 0 : ((h2 - h1 + 540) % 360) - 180;
  const deltaH = 2 * Math.sqrt(c1 * c2) * Math.sin((hueStep / 2) * rad);
  const lMean = (l1 + l2) / 2;
  const cMean = (c1 + c2) / 2;
  const wraps = c1 * c2 !== 0 && Math.abs(h1 - h2) > 180;
  const hMean = c1 * c2 === 0 ? h1 + h2 : (h1 + h2 + (wraps ? 360 : 0)) / 2;
  const t =
    1 -
    0.17 * Math.cos((hMean - 30) * rad) +
    0.24 * Math.cos(2 * hMean * rad) +
    0.32 * Math.cos((3 * hMean + 6) * rad) -
    0.2 * Math.cos((4 * hMean - 63) * rad);
  const sl = 1 + (0.015 * (lMean - 50) ** 2) / Math.sqrt(20 + (lMean - 50) ** 2);
  const sc = 1 + 0.045 * cMean;
  const sh = 1 + 0.015 * cMean * t;
  const rotation =
    -2 *
    Math.sqrt(cMean ** 7 / (cMean ** 7 + 25 ** 7)) *
    Math.sin(60 * Math.exp(-(((hMean - 275) / 25) ** 2)) * rad);
  const dl = (l2 - l1) / sl;
  const dc = (c2 - c1) / sc;
  const dh = deltaH / sh;
  return Math.sqrt(dl ** 2 + dc ** 2 + dh ** 2 + rotation * dc * dh);
}

const NEAR = 5;

const tripletRgba = (triplet: string): Rgba => {
  const [r, g, b] = triplet.split(' ').map(Number);
  return [r, g, b, 1];
};

/** Every color function in a shadow list, rewritten to one form so both sides compare. */
const normalizeShadow = (value: string) =>
  value
    .replace(/(rgba?|lch)\([^)]*\)/g, (color) => formatRgba(parseColor(color)))
    .replace(/\s+/g, ' ')
    .trim();

/** How a Click UI appearance token compares with the theme value that cites it. */
const scrimKeys: ReadonlySet<keyof IThemeAppearance> = new Set([
  'scrimOpacity',
  'alertScrimOpacity',
  'modalScrimOpacity',
]);

/** Roles read out of a Click UI `font` shorthand, and the part each one is. */
const fontShorthandParts: Partial<
  Record<keyof IThemeAppearance, 'weight' | 'size' | 'leading' | 'family'>
> = {
  dialogTitleFontWeight: 'weight',
  dialogTitleSize: 'size',
  dialogTitleLeading: 'leading',
  dialogTitleFontFamily: 'family',
  labelFontWeight: 'weight',
  labelSize: 'size',
  labelLeading: 'leading',
};

function comparable(key: keyof IThemeAppearance, raw: string | number): string {
  const value = String(raw);
  /** A scrim role is the alpha of Click UI's scrim color; the color itself is `surface-overlay`. */
  if (scrimKeys.has(key)) {
    return /^[\d.]+$/.test(value) ? String(Number(value)) : String(parseColor(value)[3]);
  }
  if (/shadow/i.test(key) || key === 'elevationSurface' || key === 'elevationDrag') {
    return normalizeShadow(value);
  }
  /** Click UI writes the label as a `font` shorthand; the role is its leading weight. */
  if (key === 'controlFontWeight') {
    return value.trim().split(/\s+/)[0];
  }
  /** A title or label is a `weight size/leading family` shorthand, one part per role. */
  if (fontShorthandParts[key] !== undefined) {
    const [, weight, size, leading, family] =
      /^(\d+)\s+([^/\s]+)\/(\S+)\s+(.+?);?$/.exec(value.trim()) ?? [];
    return { weight, size, leading, family }[fontShorthandParts[key]] ?? value;
  }
  /** A stroke is `width style color`; the role is its width, and its color is `border-light`. */
  if (key === 'dialogStroke') {
    return value.trim().split(/\s+/)[0];
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
 * Every decision is pinned per mode: `match`, `near` (a color within deltaE2000 5), `deviation` (a
 * departure the theme makes on purpose, with its reason), or `not expressible` (listed in
 * `notExpressible` with the issue that tracks the missing role). A decision that improves or
 * regresses fails by name, so move its pin when a change closes a gap. Run with
 * `CLICKUI_PARITY_REPORT=1` to print every decision and every role's status.
 */
type ParityKind = 'color' | 'shape' | 'shadow';
type Utility = 'bg' | 'text' | 'border' | 'rounded' | 'shadow' | 'w' | 'h' | 'py' | 'px' | 'gap';

interface ParityProbe {
  /** The Click UI component token the primitive should reproduce. */
  token?: string;
  /** What Click UI's component stylesheet draws for a decision no token carries, and where. */
  untokened?: { value: string; source: string };
  kind: ParityKind;
  utility: Utility;
  /** A state the utility is written under, such as `data-[state=checked]:`. */
  variant?: string;
  /** Renders the primitive and returns the element that paints the decision. */
  element?: () => Element;
  /** The value a stylesheet draws for the decision in a mode, when no class a theme role backs
   *  does, with any theme role it reads resolved under the ClickHouse theme. */
  literal?: (mode: ThemeMode) => string;
  /** The modes where the theme lands within deltaE2000 5 of Click UI rather than on it. */
  near?: ThemeMode[];
  /** Why the theme departs from Click UI on purpose, per mode. */
  deviation?: Partial<Record<ThemeMode, string>>;
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

/** The value of `property` in the first `selector` rule of a stylesheet under `src/`. */
const cssValue = (path: string, selector: string, property: string) => {
  const css = readFileSync(join(__dirname, '../..', path), 'utf8');
  const start = css.indexOf(`${selector} {`);
  const rule = start === -1 ? '' : css.slice(start, css.indexOf('}', start));
  const value = new RegExp(`${property}:\\s*([^;]+);`).exec(rule)?.[1];
  if (value === undefined) {
    throw new Error(`${path} has no ${property} in a ${selector} rule`);
  }
  return value.replace(/\s+/g, ' ').trim();
};

/** The app stylesheet, which repaints some primitive rules after the package's own. */
const APP_STYLESHEET = '../../../client/src/style.css';

/** A `var(--theme-*, fallback)` value resolved to the role it reads under the ClickHouse theme. */
function resolveRoleVar(value: string, mode: ThemeMode): string {
  const property = /^var\(\s*(--theme-[a-z0-9-]+)/.exec(value)?.[1];
  if (property === undefined) {
    return value;
  }
  const role = (Object.keys(themeAppearanceProperties) as Array<keyof IThemeAppearance>).find(
    (key) => themeAppearanceProperties[key] === property,
  );
  if (role === undefined) {
    throw new Error(`${property} is not an appearance role`);
  }
  return resolveTheme(clickHouseTheme, mode).appearance[role];
}

/**
 * A primitive rule's value with the theme role it reads resolved, after checking that the app
 * stylesheet, which loads after the package's and repeats the rule, still draws the same value.
 */
function appCopyResolved(file: string, selector: string, property: string, mode: ThemeMode) {
  const own = cssValue(`components/${file}`, selector, property);
  const app = cssValue(APP_STYLESHEET, selector, property);
  if (app !== own) {
    throw new Error(
      `The app's ${selector} ${property} (${app}) no longer repeats ${file} (${own})`,
    );
  }
  return resolveRoleVar(own, mode);
}

/**
 * The open Dropdown menu's corner. jsdom loads no stylesheet, so the rendered popover is checked
 * to take its corner from `.popover-ui` alone (no radius utility or inline radius overrides it)
 * before the rule's value is read.
 */
const popoverCorner = (mode: ThemeMode) => {
  try {
    fireEvent.click(dropdownProbe());
    const popover = document.querySelector<HTMLElement>('[role="listbox"]');
    if (!popover?.classList.contains('popover-ui')) {
      throw new Error('The open Dropdown menu no longer carries .popover-ui');
    }
    const override = [...popover.classList].find((name) => /^rounded(-|$)/.test(name));
    if (override !== undefined || popover.style.borderRadius !== '') {
      throw new Error(`The open Dropdown menu sets its own corner (${override ?? 'inline'})`);
    }
    return appCopyResolved('Dropdown.css', '.popover-ui', 'border-radius', mode);
  } finally {
    cleanup();
  }
};

/** The Dropdown menu's shadow, which reads `menuShadow`: `.popover-ui` in light, and its `.dark`
 *  rule in dark, each repeated by the app stylesheet. */
const menuShadow = (mode: ThemeMode) =>
  appCopyResolved(
    'Dropdown.css',
    mode === 'dark' ? '.popover-ui:where(.dark, .dark *)' : '.popover-ui',
    'box-shadow',
    mode,
  );

/** The Tooltip's shadow, which reads `tooltipShadow`: `.tooltip` in light, and its `.dark` rule in
 *  dark. Tooltip renders the bare `tooltip` class, so nothing but these rules paints it. */
const tooltipShadow = (mode: ThemeMode) =>
  appCopyResolved(
    'Tooltip.css',
    mode === 'dark' ? '.tooltip:where(.dark, .dark *)' : '.tooltip',
    'box-shadow',
    mode,
  );

/** The Tabs trigger, which takes its corner from a radius utility. */
const tabsProbe = () =>
  mount(
    createElement(
      Tabs,
      { defaultValue: 'a' },
      createElement(TabsList, null, createElement(TabsTrigger, { value: 'a' }, 'A')),
    ),
    '[role="tab"]',
  );

const bothModes = (reason: string): Partial<Record<ThemeMode, string>> => ({
  light: reason,
  dark: reason,
});

const buttonProbe = (variant: 'default' | 'outline') => () =>
  mount(createElement(Button, { variant }, 'Save'), 'button');

/** A button on the theme's control metrics, the size that reads the control spacing roles. */
const themeButtonProbe = () =>
  mount(createElement(Button, { size: 'theme', shape: 'theme' }, 'Save'), 'button');

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
    near: ['dark'],
  },
  'Button corner': {
    token: 'border.radii.1',
    kind: 'shape',
    utility: 'rounded',
    element: buttonProbe('default'),
  },
  'Button height': {
    token: 'click.genericMenu.panel.size.height',
    kind: 'shape',
    utility: 'h',
    element: buttonProbe('default'),
  },
  'Button inline padding': {
    token: 'click.button.basic.space.x',
    kind: 'shape',
    utility: 'px',
    element: themeButtonProbe,
  },
  'Button gap': {
    token: 'click.button.basic.space.gap',
    kind: 'shape',
    utility: 'gap',
    element: themeButtonProbe,
  },
  'Field fill': {
    token: 'click.field.color.background.default',
    kind: 'color',
    utility: 'bg',
    variant: 'theme-field-fill:',
    element: inputProbe,
  },
  'Field stroke': {
    token: 'click.field.color.stroke.default',
    kind: 'color',
    utility: 'border',
    element: inputProbe,
    deviation: bothModes(
      'border-control holds form controls to the 3:1 non-text floor stroke.default misses',
    ),
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
    deviation: bothModes(
      'border-control holds form controls to the 3:1 non-text floor stroke.default misses',
    ),
  },
  'Dropdown trigger corner': {
    token: 'border.radii.1',
    kind: 'shape',
    utility: 'rounded',
    element: dropdownProbe,
  },
  'Dropdown menu corner': {
    token: 'click.genericMenu.panel.radii.all',
    kind: 'shape',
    utility: 'rounded',
    literal: popoverCorner,
  },
  'Dropdown menu shadow': {
    token: 'click.genericMenu.panel.shadow.default',
    kind: 'shadow',
    utility: 'shadow',
    literal: menuShadow,
  },
  'Tooltip corner': {
    token: 'click.tooltip.radii.all',
    kind: 'shape',
    utility: 'rounded',
    literal: (mode) => appCopyResolved('Tooltip.css', '.tooltip', 'border-radius', mode),
  },
  'Tooltip shadow': {
    untokened: { value: 'none', source: 'Tooltip.module.css .content sets no box-shadow' },
    kind: 'shadow',
    utility: 'shadow',
    literal: tooltipShadow,
  },
  'Tabs corner': {
    token: 'click.tabs.radii.all',
    kind: 'shape',
    utility: 'rounded',
    element: tabsProbe,
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
    deviation: {
      dark: 'surface-overlay keeps the dark scrim black; Click UI #606060 lifts the page it covers',
    },
  },
  'Dialog inline padding': {
    token: 'click.dialog.space.x',
    kind: 'shape',
    utility: 'px',
    element: dialogProbe('[role="dialog"]'),
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
    deviation: {
      light: 'switch-unchecked holds the off track to the 3:1 non-text floor #cccfd3 misses',
      dark: 'switch-unchecked holds the off track to the 3:1 non-text floor #606060 misses',
    },
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
    deviation: bothModes(
      'the table has no frame of its own; each consumer draws the panel it sits in',
    ),
  },
  'Badge fill': {
    token: 'click.badge.opaque.color.background.default',
    kind: 'color',
    utility: 'bg',
    element: badgeProbe,
    near: ['light'],
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

interface NotExpressible {
  /** The parity decisions the gap leaves unmatched, per mode. */
  decisions: Partial<Record<ThemeMode, string[]>>;
  /** Why no theme can reach Click UI's value today. */
  reason: string;
  /** The berry-13/LibreChat issue that tracks the role or change that closes it. */
  issue: string;
}

/**
 * Every Click UI decision the theme engine cannot express, and why. Each one needs a role or a
 * primitive change that keeps the default theme pixel-identical; a theme's values alone cannot
 * close it. Remove an entry when the change that closes it lands, and pin its decisions to what
 * they then measure.
 */
const notExpressible: Record<string, NotExpressible> = {};

type Verdict = 'match' | 'near' | 'deviation' | 'not expressible';

const notExpressibleGap = (mode: ThemeMode, decision: string) =>
  Object.entries(notExpressible).find(([, gap]) => gap.decisions[mode]?.includes(decision))?.[0];

/** What a decision is pinned to in `mode`. */
function pinnedVerdict(mode: ThemeMode, decision: string, probe: ParityProbe): Verdict {
  if (notExpressibleGap(mode, decision) !== undefined) {
    return 'not expressible';
  }
  if (probe.deviation?.[mode] !== undefined) {
    return 'deviation';
  }
  return probe.near?.includes(mode) ? 'near' : 'match';
}

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
  'theme-tab': 'tabRadius',
};

const fixedRadii: Record<string, string> = { full: '9999px', none: '0px' };

type SizeUtility = 'w' | 'h' | 'py' | 'px' | 'gap';

const sizeRoles: Record<SizeUtility, Record<string, keyof IThemeAppearance>> = {
  w: { 'theme-switch': 'switchWidth' },
  h: {
    'theme-switch': 'switchHeight',
    'theme-control': 'controlHeight',
    'theme-button': 'buttonHeight',
    'theme-button-sm': 'buttonHeightSm',
  },
  py: { 'theme-table-cell': 'tableCellSpaceY', 'theme-field-y': 'fieldPaddingY' },
  px: { 'theme-control-x': 'controlPaddingX', 'theme-dialog-x': 'dialogPaddingX' },
  gap: { 'theme-control-gap': 'controlGap' },
};

/** The compact and dense table sizes divide the cell space, as the preset does. */
const derivedSizes: Record<string, [keyof IThemeAppearance, number]> = {
  'theme-table-cell-compact': ['tableCellSpaceY', 2],
  'theme-table-cell-dense': ['tableCellSpaceY', 4],
};

const isSizeUtility = (utility: Utility): utility is SizeUtility => utility in sizeRoles;

/** A `border`, `border-2` or one-sided `border-b` class, or a theme stroke role that is not
 *  zero: the width a border color needs to show. */
const drawsBorder = (classes: string[], resolved: Resolved) =>
  classes.some(
    (name) =>
      /^border(-[0-9]+|-[xytblrse](-[0-9]+)?)?$/.test(name) ||
      (/^border(-[xytblrse])?-\(length:--theme-table-row-stroke\)$/.test(name) &&
        parseFloat(resolved.appearance.tableRowStroke) > 0) ||
      (name === 'border-(length:--theme-dialog-stroke)' &&
        parseFloat(resolved.appearance.dialogStroke) > 0),
  );

type Resolved = ReturnType<typeof resolveTheme>;

/** A `w-*`, `h-*`, `py-*`, `px-*` or `gap-*` step: a theme role, or Tailwind's 0.25rem scale. */
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
  /** `bg-scrim` is `surface-overlay` at the theme's scrim opacity (`--color-scrim` in tokens.css). */
  if (role === 'scrim') {
    const [r, g, b] = tripletRgba(resolved.colors['rgb-surface-overlay']);
    return [r, g, b, Number(resolved.appearance.scrimOpacity)];
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
  const value = isSizeUtility(utility)
    ? sizeValue(utility, role, resolved)
    : (fixedRadii[role] ?? resolved.appearance[radiusRoles[role]]);
  if (value === undefined) {
    throw new Error(`No theme role or scale step resolves ${utility}-${role}`);
  }
  return value;
}

/** `off` is any departure past near; the pin says whether it is a deviation or a gap. */
type Measured = 'match' | 'near' | 'off';

interface ParityResult {
  decision: string;
  measured: Measured;
  theme: string;
  clickUi: string;
}

const nearColor = (a: Rgba, b: Rgba) => Math.abs(a[3] - b[3]) < 0.01 && deltaE(a, b) < NEAR;

function measure(mode: ThemeMode, decision: string, probe: ParityProbe): ParityResult {
  const source = probe.token !== undefined ? clickToken(mode, probe.token) : probe.untokened?.value;
  if (source === undefined) {
    throw new Error(`Parity probe ${decision} names neither a Click UI token nor a drawn value`);
  }
  const base = { decision, clickUi: source };
  if (probe.literal) {
    const value = probe.literal(mode);
    const same =
      probe.kind === 'shadow'
        ? normalizeShadow(value) === normalizeShadow(source)
        : value === source;
    return { ...base, theme: `literal = ${value}`, measured: same ? 'match' : 'off' };
  }
  if (!probe.element) {
    throw new Error(`Parity probe ${decision} has neither an element nor a literal`);
  }
  const resolved = resolveTheme(clickHouseTheme, mode);
  const element = probe.element();
  const role =
    probe.utility === 'text'
      ? inheritedTextRole(element, probe, resolved)
      : paintedRole(element, probe, resolved);
  cleanup();
  const painted = role === undefined ? 'unpainted' : `${probe.utility}-${role}`;
  if (probe.kind === 'shape') {
    const theme = shapeValue(probe.utility, role, resolved);
    return {
      ...base,
      theme: `${painted} = ${theme}`,
      measured: theme === source ? 'match' : 'off',
    };
  }
  const color = role === undefined ? ([0, 0, 0, 0] as Rgba) : roleColor(resolved, role);
  const theme = `${painted} = ${color ? formatRgba(color) : 'unresolved'}`;
  if (color === undefined) {
    return { ...base, theme, measured: 'off' };
  }
  const clickUi = clickColor(source);
  if (sameColor(color, clickUi)) {
    return { ...base, theme, measured: 'match' };
  }
  return { ...base, theme, measured: nearColor(color, clickUi) ? 'near' : 'off' };
}

/** The status of every color role against the Click UI token that names its job. */
function roleStatuses(mode: ThemeMode): Array<[keyof IThemeRGB, RoleStatus, string]> {
  const colors = clickHouseTheme.modes[mode]?.colors ?? {};
  return (Object.keys(colors) as Array<keyof IThemeRGB>).map((key) => {
    const departure = departures[mode][key];
    const token = departure?.counterpart ?? colorSources[mode][key];
    if (token === undefined) {
      return [key, 'mismatch', 'unsourced'];
    }
    const theme = tripletRgba(colors[key] ?? '');
    const counterpart = clickColor(clickToken(mode, token));
    const distance = deltaE(theme, counterpart);
    const departed: RoleStatus = distance < NEAR ? 'near' : 'mismatch';
    const status = sameRgb(colors[key] ?? '', counterpart) ? 'match' : departed;
    const why = departure === undefined ? '' : `: ${departure.reason}`;
    return [key, status, `${token} dE ${distance.toFixed(2)}${why}`];
  });
}

/** The status of every appearance role the theme sets. */
function appearanceStatuses(mode: ThemeMode): Array<[keyof IThemeAppearance, RoleStatus, string]> {
  const appearance = clickHouseTheme.modes[mode]?.appearance ?? {};
  return (Object.keys(appearance) as Array<keyof IThemeAppearance>).map((key) => {
    const decision = appearanceDecisions[key];
    if (decision?.token !== undefined) {
      const source = clickToken(mode, decision.token);
      const same = comparable(key, String(appearance[key])) === comparable(key, source);
      return [key, same ? 'match' : 'mismatch', `${decision.token} ${source}: ${decision.reason}`];
    }
    if (decision !== undefined) {
      return [key, decision.status, decision.reason];
    }
    const token = appearanceSources[key] ?? 'unsourced';
    const theme = String(appearance[key]);
    const source = clickToken(mode, token);
    if (comparable(key, theme) !== comparable(key, source)) {
      return [key, 'mismatch', token];
    }
    return [key, 'match', token];
  });
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

  it.each(modes)('draws the %s Click UI spaces a role carries from that role', (mode) => {
    const appearance = resolveTheme(clickHouseTheme, mode).appearance;
    const drift = Object.entries(clickSpaces).flatMap(([token, counterpart]) => {
      if (counterpart.startsWith('p-')) {
        return [];
      }
      const role = counterpart as keyof IThemeAppearance;
      const source = remOf(clickToken(mode, token));
      return remOf(appearance[role]) === source
        ? []
        : [`${token} ${source}rem: ${role} draws ${appearance[role]}`];
    });

    expect(drift).toEqual([]);
  });

  it.each(modes)('keeps only the %s tokens the theme cites in the snapshot', (mode) => {
    const cited = new Set([
      ...Object.values(colorSources[mode]),
      ...Object.values(departures[mode]).map((departure) => departure.counterpart),
      ...Object.values(appearanceSources),
      ...Object.keys(clickSpaces),
      ...Object.values(appearanceDecisions).flatMap(({ token }) => (token ? [token] : [])),
      ...Object.values(parityProbes).flatMap((probe) => (probe.token ? [probe.token] : [])),
    ]);

    expect(Object.keys(tokens[mode]).filter((token) => !cited.has(token))).toEqual([]);
  });
});

describe('ClickHouse primitive parity against Click UI components', () => {
  const report = (lines: string[]) => {
    if (process.env.CLICKUI_PARITY_REPORT) {
      console.info(lines.join('\n'));
    }
  };

  it.each(modes)('lands every %s decision on its pinned verdict', (mode) => {
    const rows = Object.entries(parityProbes).map(([decision, probe]) => {
      const pinned = pinnedVerdict(mode, decision, probe);
      const result = measure(mode, decision, probe);
      const why = probe.deviation?.[mode] ?? notExpressibleGap(mode, decision) ?? '';
      return { pinned, result, why };
    });
    const tally = rows.reduce<Record<string, number>>(
      (counts, { pinned }) => ({ ...counts, [pinned]: (counts[pinned] ?? 0) + 1 }),
      {},
    );
    report([
      `${mode}: ${rows.length} decisions ${JSON.stringify(tally)}`,
      ...rows.map(
        ({ pinned, result, why }) =>
          `${pinned}\t${result.decision}\t${result.theme}\t${result.clickUi}\t${why}`,
      ),
    ]);

    const expected = (pinned: Verdict): Measured =>
      pinned === 'match' || pinned === 'near' ? pinned : 'off';
    const moved = rows
      .filter(({ pinned, result }) => result.measured !== expected(pinned))
      .map(
        ({ pinned, result }) =>
          `${result.decision}: pinned ${pinned}, measures ${result.measured} (${result.theme}, Click UI ${result.clickUi})`,
      );
    expect(moved).toEqual([]);
  });

  it('keeps the not-expressible list to real, tracked, unmatched decisions', () => {
    const problems = Object.entries(notExpressible).flatMap(
      ([gap, { decisions, reason, issue }]) => [
        ...(reason.trim() === '' ? [`${gap}: no reason`] : []),
        ...(Object.values(decisions).some((listed) => (listed?.length ?? 0) > 0)
          ? []
          : [`${gap}: names no decision`]),
        ...(/^https:\/\/github\.com\/berry-13\/LibreChat\/issues\/\d+$/.test(issue)
          ? []
          : [`${gap}: ${issue} is not a berry-13/LibreChat issue`]),
        ...modes.flatMap((mode) =>
          (decisions[mode] ?? []).flatMap((decision) => {
            const probe = parityProbes[decision];
            if (probe === undefined) {
              return [`${gap}: ${decision} is not a parity decision`];
            }
            if (notExpressibleGap(mode, decision) !== gap) {
              return [`${gap}: ${mode} ${decision} is listed under another gap too`];
            }
            return probe.deviation?.[mode] === undefined && probe.near?.includes(mode) !== true
              ? []
              : [`${gap}: ${mode} ${decision} is also pinned near or deviation`];
          }),
        ),
      ],
    );
    report([
      `not expressible: ${Object.keys(notExpressible).length}`,
      ...Object.entries(notExpressible).map(
        ([gap, { reason, issue }]) => `${gap}\t${issue}\t${reason}`,
      ),
    ]);

    expect(problems).toEqual([]);
  });

  it.each(modes)('pins the %s status of every color role against Click UI', (mode) => {
    const statuses = roleStatuses(mode);
    const count = (status: RoleStatus) => statuses.filter(([, value]) => value === status).length;
    report([
      `${mode} roles: match ${count('match')}, near ${count('near')}, mismatch ${count('mismatch')}`,
      ...statuses.map(([key, status, detail]) => `${status}\t${key}\t${detail}`),
    ]);

    const moved = statuses.flatMap(([key, status]) => {
      const pinned = departures[mode][key]?.status ?? 'match';
      return status === pinned ? [] : [`${key}: pinned ${pinned}, measures ${status}`];
    });
    const stale = Object.keys(departures[mode]).filter(
      (key) => !statuses.some(([role]) => role === key),
    );
    expect({ moved, stale }).toEqual({ moved: [], stale: [] });
  });

  it.each(modes)('pins the %s status of every appearance role against Click UI', (mode) => {
    const statuses = appearanceStatuses(mode);
    report([
      `${mode} appearance:`,
      ...statuses.map(([key, status, detail]) => `${status}\t${key}\t${detail}`),
    ]);

    const appearance = clickHouseTheme.modes[mode]?.appearance ?? {};
    const moved = Object.entries(appearanceDecisions).flatMap(([key, { value }]) => {
      const theme = String(appearance[key as keyof IThemeAppearance]);
      return theme === value ? [] : [`${key}: decided at ${value}, the theme sets ${theme}`];
    });

    expect(moved).toEqual([]);
    expect(statuses.filter(([, status]) => status === 'mismatch').map(([key]) => key)).toEqual([
      'text2xl',
    ]);
    expect(statuses.filter(([, status]) => status === 'near').map(([key]) => key)).toEqual([]);
  });
});

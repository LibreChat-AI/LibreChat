import type { ThemeDefinition } from '../types';
import applyTheme, {
  applyResolvedTheme,
  clearAppliedTheme,
  themeOwnedProperties,
} from './applyTheme';
import { highContrastTheme, resolveTheme } from '../registry';
import { defaultTheme } from '../themes/default';

const semanticProperties = [
  '--link',
  '--link-hover',
  '--link-visited',
  '--accent-primary',
  '--accent-primary-hover',
  '--text-destructive',
  '--text-muted',
  '--chart-widget-surface',
  '--chart-widget-stroke',
  '--border-destructive',
  '--status-success',
  '--status-success-subtle',
  '--status-success-border',
  '--status-success-strong',
  '--surface-overlay',
  '--surface-hover',
  '--surface-composer-hover',
  '--text-on-status',
  '--status-error',
  '--status-neutral-border',
];

afterEach(() => {
  semanticProperties.forEach((property) => document.documentElement.style.removeProperty(property));
  clearAppliedTheme();
});

describe('applyTheme', () => {
  it('applies link and accent colors from runtime themes', () => {
    applyTheme({
      'rgb-link': '1 2 3',
      'rgb-link-hover': '4 5 6',
      'rgb-link-visited': '7 8 9',
      'rgb-accent-primary': '10 11 12',
      'rgb-accent-primary-hover': '13 14 15',
    });

    expect(document.documentElement.style.getPropertyValue('--link')).toBe('1 2 3');
    expect(document.documentElement.style.getPropertyValue('--link-hover')).toBe('4 5 6');
    expect(document.documentElement.style.getPropertyValue('--link-visited')).toBe('7 8 9');
    expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('10 11 12');
    expect(document.documentElement.style.getPropertyValue('--accent-primary-hover')).toBe(
      '13 14 15',
    );
  });

  it('applies the composer hover surface from runtime themes', () => {
    applyTheme({
      'rgb-surface-composer-hover': '66 66 66',
    });

    expect(document.documentElement.style.getPropertyValue('--surface-composer-hover')).toBe(
      '66 66 66',
    );
  });

  it('keeps existing custom hover colors on composer controls', () => {
    applyTheme({
      'rgb-surface-hover': '44 45 46',
    });

    expect(document.documentElement.style.getPropertyValue('--surface-hover')).toBe('44 45 46');
    expect(document.documentElement.style.getPropertyValue('--surface-composer-hover')).toBe(
      '44 45 46',
    );
  });

  it('applies status and destructive colors from runtime themes', () => {
    applyTheme({
      'rgb-text-destructive': '20 21 22',
      'rgb-border-destructive': '23 24 25',
      'rgb-status-success': '26 27 28',
      'rgb-status-success-subtle': '29 30 31',
      'rgb-status-success-border': '32 33 34',
      'rgb-status-success-strong': '33 34 35',
      'rgb-status-error': '35 36 37',
      'rgb-status-neutral-border': '38 39 40',
      'rgb-surface-overlay': '39 40 41',
      'rgb-text-on-status': '42 43 44',
    });

    const style = document.documentElement.style;
    expect(style.getPropertyValue('--text-destructive')).toBe('20 21 22');
    expect(style.getPropertyValue('--border-destructive')).toBe('23 24 25');
    expect(style.getPropertyValue('--status-success')).toBe('26 27 28');
    expect(style.getPropertyValue('--status-success-subtle')).toBe('29 30 31');
    expect(style.getPropertyValue('--status-success-border')).toBe('32 33 34');
    expect(style.getPropertyValue('--status-success-strong')).toBe('33 34 35');
    expect(style.getPropertyValue('--status-error')).toBe('35 36 37');
    expect(style.getPropertyValue('--status-neutral-border')).toBe('38 39 40');
    expect(style.getPropertyValue('--surface-overlay')).toBe('39 40 41');
    expect(style.getPropertyValue('--text-on-status')).toBe('42 43 44');
  });

  it('ships status tokens in the bundled themes', () => {
    applyTheme(defaultTheme);

    expect(document.documentElement.style.getPropertyValue('--status-error')).toBe(
      defaultTheme['rgb-status-error'],
    );
    expect(document.documentElement.style.getPropertyValue('--surface-overlay')).toBe('89 89 89');
  });

  it('applies a resolved appearance atomically', () => {
    const referenceTheme: ThemeDefinition = {
      version: 1,
      name: 'compact-reference',
      modes: {
        light: {
          appearance: {
            controlRadius: '0.25rem',
            roundControlRadius: '0.25rem',
            surfaceRadius: '0.5rem',
            largeSurfaceRadius: '0.5rem',
            motionFast: '80ms',
          },
        },
      },
    };

    applyResolvedTheme(resolveTheme(referenceTheme, 'light'));

    const root = document.documentElement;
    expect(root.dataset.theme).toBe('compact-reference');
    expect(root.style.getPropertyValue('--theme-control-radius')).toBe('0.25rem');
    expect(root.style.getPropertyValue('--theme-surface-radius')).toBe('0.5rem');
    expect(root.style.getPropertyValue('--theme-motion-fast')).toBe('80ms');
  });

  it('applies the resolved high-contrast code surface instead of the stock grey', () => {
    const root = document.documentElement;

    applyResolvedTheme(resolveTheme(highContrastTheme, 'dark'), root);

    expect(root.style.getPropertyValue('--surface-code')).toBe('0 0 0');
  });

  /** The sweep under an in-flight label is painted in CSS, so it is only
   *  themeable if its stops are theme-owned properties. A dark theme is the
   *  case that matters: `style.css` declares a `.dark` base outright, which a
   *  theme can only outrank by having these applied to the document element. */
  it('lets a dark theme restate the in-flight label sweep', () => {
    const root = document.documentElement;

    applyResolvedTheme(
      resolveTheme(
        {
          version: 1,
          name: 'shimmer-reference',
          modes: {
            dark: { colors: { 'rgb-shimmer-base': '12 200 180', 'rgb-shimmer-dip': '4 60 55' } },
          },
        },
        'dark',
      ),
      root,
    );

    expect(root.style.getPropertyValue('--shimmer-base')).toBe('12 200 180');
    expect(root.style.getPropertyValue('--shimmer-dip')).toBe('4 60 55');
    expect(themeOwnedProperties).toEqual(
      expect.arrayContaining(['--shimmer-base', '--shimmer-dip']),
    );

    clearAppliedTheme(root);
    expect(root.style.getPropertyValue('--shimmer-base')).toBe('');
  });

  /** Legacy `themeRGB` themes predate the shimmer stops and this adapter applies
   *  only the keys they name, so a stored theme would otherwise keep the stock
   *  sweep while the rest of its palette moved — and in dark the CSS cannot
   *  recover, since `.dark` declares a base that outranks the fallback. */
  it('carries a legacy theme without shimmer keys onto its own text color', () => {
    const root = document.documentElement;

    applyTheme({ 'rgb-text-primary': '10 20 30' }, root);

    expect(root.style.getPropertyValue('--shimmer-base')).toBe('10 20 30');
  });

  it('leaves a legacy theme that names its own shimmer base alone', () => {
    const root = document.documentElement;

    applyTheme({ 'rgb-text-primary': '10 20 30', 'rgb-shimmer-base': '90 80 70' }, root);

    expect(root.style.getPropertyValue('--shimmer-base')).toBe('90 80 70');
  });

  it('carries a legacy theme without muted text onto its tertiary text color', () => {
    const root = document.documentElement;

    applyTheme({ 'rgb-text-tertiary': '80 81 82' }, root);

    expect(root.style.getPropertyValue('--text-muted')).toBe('80 81 82');
  });

  it('leaves a legacy theme that names muted text alone', () => {
    const root = document.documentElement;

    applyTheme({ 'rgb-text-tertiary': '80 81 82', 'rgb-text-muted': '100 101 102' }, root);

    expect(root.style.getPropertyValue('--text-muted')).toBe('100 101 102');
  });

  it('carries legacy panel colors onto chart widgets', () => {
    const root = document.documentElement;

    applyTheme({ 'rgb-surface-primary': '20 21 22', 'rgb-border-light': '30 31 32' }, root);

    expect(root.style.getPropertyValue('--chart-widget-surface')).toBe('20 21 22');
    expect(root.style.getPropertyValue('--chart-widget-stroke')).toBe('30 31 32');
  });

  it('leaves explicit chart widget colors alone', () => {
    const root = document.documentElement;

    applyTheme(
      {
        'rgb-surface-primary': '20 21 22',
        'rgb-border-light': '30 31 32',
        'rgb-chart-widget-surface': '40 41 42',
        'rgb-chart-widget-stroke': '50 51 52',
      },
      root,
    );

    expect(root.style.getPropertyValue('--chart-widget-surface')).toBe('40 41 42');
    expect(root.style.getPropertyValue('--chart-widget-stroke')).toBe('50 51 52');
  });

  it('carries a legacy theme without a verified fill onto its success fill', () => {
    const root = document.documentElement;

    applyTheme({ 'rgb-status-success-strong': '8 135 89' }, root);

    expect(root.style.getPropertyValue('--status-verified')).toBe('8 135 89');
  });

  it('leaves a legacy theme that names its own verified fill alone', () => {
    const root = document.documentElement;

    applyTheme(
      { 'rgb-status-success-strong': '8 135 89', 'rgb-status-verified': '26 127 216' },
      root,
    );

    expect(root.style.getPropertyValue('--status-verified')).toBe('26 127 216');
  });

  it('carries a legacy theme that names no fills onto the mode palette it inherits', () => {
    const root = document.documentElement;

    applyTheme({ 'rgb-surface-tertiary': '30 30 38' }, root, {
      'rgb-status-success-strong': '8 135 89',
    });

    expect(root.style.getPropertyValue('--status-verified')).toBe('8 135 89');
  });

  it('leaves the verified fill alone for a legacy theme that repaints nothing around the mark', () => {
    const root = document.documentElement;

    applyTheme({ 'rgb-text-primary': '10 20 30' }, root, {
      'rgb-status-success-strong': '8 135 89',
    });

    expect(root.style.getPropertyValue('--status-verified')).toBe('');
  });

  it('clears only properties owned by the theme module', () => {
    const root = document.documentElement;
    root.style.setProperty('--text-primary', '1 2 3');
    root.style.setProperty('--theme-control-radius', '0.25rem');
    root.style.setProperty('--markdown-font-size', '18px');

    clearAppliedTheme(root);

    expect(root.style.getPropertyValue('--text-primary')).toBe('');
    expect(root.style.getPropertyValue('--theme-control-radius')).toBe('');
    expect(root.style.getPropertyValue('--markdown-font-size')).toBe('18px');
    root.style.removeProperty('--markdown-font-size');
  });

  it('applies provider brand backgrounds from the theme', () => {
    applyResolvedTheme(
      resolveTheme(
        {
          version: 1,
          name: 'white-label',
          modes: { light: {} },
          brands: { 'provider-openai': '#123456' },
        },
        'light',
      ),
    );

    expect(document.documentElement.style.getPropertyValue('--provider-openai')).toBe('#123456');
  });
});

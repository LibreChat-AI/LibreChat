import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { ThemeDefinition } from './types';
import {
  collectThemeWarnings,
  darkAppearanceDefaults,
  defaultAppearanceFor,
  defaultAppearance,
  defaultBrands,
  fromLegacyTheme,
  libreChatTheme,
  resolveTheme,
  themeColorTokens,
  validateThemeDefinition,
} from './registry';
import { clickHouseTheme } from './themes/clickhouse';
import { defaultTheme } from './themes/default';
import { darkTheme } from './themes/dark';
import * as themeEntry from './index';

const compactTheme: ThemeDefinition = {
  version: 1,
  name: 'compact-reference',
  modes: {
    light: {
      colors: { 'rgb-accent-primary': '1 2 3' },
      appearance: {
        controlRadius: '0.25rem',
        roundControlRadius: '0.25rem',
        surfaceRadius: '0.5rem',
        largeSurfaceRadius: '0.5rem',
        controlHeight: '2rem',
        spaceCompact: '0.25rem',
        spaceNormal: '0.5rem',
        motionFast: '80ms',
        motionNormal: '120ms',
      },
    },
  },
};

describe('theme registry', () => {
  it('keeps bundled light and dark themes complete against the canonical registry', () => {
    expect(Object.keys(defaultTheme).sort()).toEqual([...themeColorTokens].sort());
    expect(Object.keys(darkTheme).sort()).toEqual([...themeColorTokens].sort());
  });

  it('resolves partial definitions against mode-specific LibreChat defaults', () => {
    const light = resolveTheme(compactTheme, 'light');
    const dark = resolveTheme(compactTheme, 'dark');

    expect(light.colors['rgb-accent-primary']).toBe('1 2 3');
    expect(light.colors['rgb-text-primary']).toBe(defaultTheme['rgb-text-primary']);
    expect(light.appearance.controlRadius).toBe('0.25rem');
    expect(light.appearance.fontFamily).toBe(defaultAppearance.fontFamily);
    expect(dark.colors['rgb-text-primary']).toBe(darkTheme['rgb-text-primary']);
    expect(dark.appearance).toEqual(defaultAppearanceFor('dark'));
  });

  it('derives omitted code surfaces from the mode-specific legacy canvas', () => {
    const theme = fromLegacyTheme(
      {
        'rgb-surface-primary-alt': '12 34 56',
        'rgb-presentation': '210 211 212',
      },
      'legacy-code-reference',
    );

    expect(resolveTheme(theme, 'light').colors['rgb-surface-code']).toBe('12 34 56');
    expect(resolveTheme(theme, 'dark').colors['rgb-surface-code']).toBe('210 211 212');
  });

  it('preserves explicit code surfaces instead of deriving them', () => {
    const theme: ThemeDefinition = {
      version: 1,
      name: 'explicit-code-reference',
      modes: {
        light: {
          colors: {
            'rgb-surface-primary-alt': '12 34 56',
            'rgb-surface-code': '65 43 21',
          },
        },
        dark: {
          colors: {
            'rgb-presentation': '210 211 212',
            'rgb-surface-code': '98 76 54',
          },
        },
      },
    };

    expect(resolveTheme(theme, 'light').colors['rgb-surface-code']).toBe('65 43 21');
    expect(resolveTheme(theme, 'dark').colors['rgb-surface-code']).toBe('98 76 54');
  });

  it('keeps a legacy theme code pane on the surfaces it was painted with', () => {
    const theme = fromLegacyTheme(
      {
        'rgb-surface-chat': '12 34 56',
        'rgb-surface-primary-alt': '210 211 212',
      },
      'legacy-code-body-reference',
    );

    expect(resolveTheme(theme, 'light').colors['rgb-surface-code-body']).toBe('12 34 56');
    expect(resolveTheme(theme, 'dark').colors['rgb-surface-code-body']).toBe('210 211 212');
  });

  it('preserves an explicit code pane instead of deriving it', () => {
    const theme: ThemeDefinition = {
      version: 1,
      name: 'explicit-code-body-reference',
      modes: {
        light: {
          colors: { 'rgb-surface-chat': '12 34 56', 'rgb-surface-code-body': '65 43 21' },
        },
        dark: {
          colors: { 'rgb-surface-primary-alt': '210 211 212', 'rgb-surface-code-body': '98 76 54' },
        },
      },
    };

    expect(resolveTheme(theme, 'light').colors['rgb-surface-code-body']).toBe('65 43 21');
    expect(resolveTheme(theme, 'dark').colors['rgb-surface-code-body']).toBe('98 76 54');
  });

  it('paints the default code pane white in light and gray-850 in dark', () => {
    expect(resolveTheme(libreChatTheme, 'light').colors['rgb-surface-code-body']).toBe(
      '255 255 255',
    );
    expect(resolveTheme(libreChatTheme, 'dark').colors['rgb-surface-code-body']).toBe('23 23 23');
  });

  it('keeps the bundled code surfaces unchanged for the default appearances', () => {
    expect(resolveTheme(libreChatTheme, 'light').colors['rgb-surface-code']).toBe(
      defaultTheme['rgb-surface-code'],
    );
    expect(resolveTheme(libreChatTheme, 'dark').colors['rgb-surface-code']).toBe(
      darkTheme['rgb-surface-code'],
    );
  });

  /** Themes predate the shimmer stops, so an omission means "not written yet",
   *  not "wants LibreChat's sweep". Filling it from the bundled base would light
   *  a white-text theme's in-flight labels in the stock near-black. */
  it('derives an omitted shimmer base from a theme that restates its text', () => {
    const inverted = resolveTheme(
      {
        version: 1,
        name: 'inverted-reference',
        modes: { light: { colors: { 'rgb-text-primary': '255 255 255' } } },
      },
      'light',
    );

    expect(inverted.colors['rgb-shimmer-base']).toBe('255 255 255');
    expect(inverted.colors['rgb-shimmer-dip']).toBe(defaultTheme['rgb-shimmer-dip']);
  });

  it('leaves a theme that names its own shimmer base alone', () => {
    const explicit = resolveTheme(
      {
        version: 1,
        name: 'explicit-reference',
        modes: {
          light: { colors: { 'rgb-text-primary': '255 255 255', 'rgb-shimmer-base': '10 20 30' } },
        },
      },
      'light',
    );

    expect(explicit.colors['rgb-shimmer-base']).toBe('10 20 30');
  });

  it('keeps the bundled shimmer base for a theme that restates nothing', () => {
    expect(resolveTheme(compactTheme, 'dark').colors['rgb-shimmer-base']).toBe(
      darkTheme['rgb-shimmer-base'],
    );
  });

  it('derives omitted muted text from a theme that restates tertiary text', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'legacy-muted-reference',
        modes: { dark: { colors: { 'rgb-text-tertiary': '120 121 122' } } },
      },
      'dark',
    );

    expect(resolved.colors['rgb-text-muted']).toBe('120 121 122');
  });

  it('preserves an explicit muted text color', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'explicit-muted-reference',
        modes: {
          light: {
            colors: {
              'rgb-text-tertiary': '120 121 122',
              'rgb-text-muted': '90 91 92',
            },
          },
        },
      },
      'light',
    );

    expect(resolved.colors['rgb-text-muted']).toBe('90 91 92');
  });

  it('keeps prose links on the link role in light and on primary text in dark', () => {
    expect(resolveTheme(libreChatTheme, 'light').colors['rgb-link-prose']).toBe(
      defaultTheme['rgb-link'],
    );
    expect(resolveTheme(libreChatTheme, 'dark').colors['rgb-link-prose']).toBe(
      darkTheme['rgb-text-primary'],
    );
  });

  it('derives omitted prose links from the link a theme names, in either mode', () => {
    const colors = { 'rgb-link': '250 255 105', 'rgb-text-primary': '240 240 240' };
    const theme: ThemeDefinition = {
      version: 1,
      name: 'prose-link-reference',
      modes: { light: { colors }, dark: { colors } },
    };

    expect(resolveTheme(theme, 'light').colors['rgb-link-prose']).toBe('250 255 105');
    expect(resolveTheme(theme, 'dark').colors['rgb-link-prose']).toBe('250 255 105');
  });

  it('keeps dark prose links on the primary text of a theme that names no link', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'prose-text-reference',
        modes: { dark: { colors: { 'rgb-text-primary': '240 240 240' } } },
      },
      'dark',
    );

    expect(resolved.colors['rgb-link-prose']).toBe('240 240 240');
  });

  it('preserves an explicit prose link color', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'explicit-prose-link-reference',
        modes: { dark: { colors: { 'rgb-link': '1 2 3', 'rgb-link-prose': '4 5 6' } } },
      },
      'dark',
    );

    expect(resolved.colors['rgb-link-prose']).toBe('4 5 6');
  });

  it('derives omitted chart widget colors from the previous panel roles', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'legacy-chart-widget-reference',
        modes: {
          dark: {
            colors: {
              'rgb-surface-primary': '20 21 22',
              'rgb-border-light': '30 31 32',
            },
          },
        },
      },
      'dark',
    );

    expect(resolved.colors['rgb-chart-widget-surface']).toBe('20 21 22');
    expect(resolved.colors['rgb-chart-widget-stroke']).toBe('30 31 32');
  });

  it('preserves explicit chart widget colors', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'explicit-chart-widget-reference',
        modes: {
          dark: {
            colors: {
              'rgb-surface-primary': '20 21 22',
              'rgb-border-light': '30 31 32',
              'rgb-chart-widget-surface': '40 41 42',
              'rgb-chart-widget-stroke': '50 51 52',
            },
          },
        },
      },
      'dark',
    );

    expect(resolved.colors['rgb-chart-widget-surface']).toBe('40 41 42');
    expect(resolved.colors['rgb-chart-widget-stroke']).toBe('50 51 52');
  });

  it('accepts table lengths in px or rem, zero included, and rejects other units', () => {
    const withTable = (tableCellSpaceY: string, tableRowStroke: string) =>
      ({
        version: 1,
        name: 'table',
        modes: { light: { appearance: { tableCellSpaceY, tableRowStroke } } },
      }) as ThemeDefinition;

    expect(validateThemeDefinition(withTable('0.5rem', '0'))).toEqual([]);
    expect(validateThemeDefinition(withTable('8px', '1px'))).toEqual([]);
    expect(validateThemeDefinition(withTable('1em', 'calc(1px - 0px)'))).toEqual([
      'Invalid appearance value for tableCellSpaceY: 1em',
      'Invalid appearance value for tableRowStroke: calc(1px - 0px)',
    ]);
  });

  describe('switch size pair', () => {
    const withSwitch = (switchWidth: string, switchHeight: string) =>
      ({
        version: 1,
        name: 'switch',
        modes: { light: { appearance: { switchWidth, switchHeight } } },
      }) as ThemeDefinition;

    it('checks one named dimension against the default it is drawn with', () => {
      const widthOnly = {
        version: 1,
        name: 'switch-width',
        modes: { light: { appearance: { switchWidth: '1rem' } } },
      } as ThemeDefinition;

      expect(validateThemeDefinition(widthOnly)).toEqual([
        'switchWidth must exceed switchHeight so the knob can travel: 1rem, 1.5rem',
      ]);
    });

    it('accepts a pair in one unit that leaves a knob and a forward travel', () => {
      expect(validateThemeDefinition(withSwitch('2rem', '1rem'))).toEqual([]);
      expect(validateThemeDefinition(withSwitch('40px', '20px'))).toEqual([]);
    });

    it('rejects a mixed-unit pair, which only holds at one root size', () => {
      expect(validateThemeDefinition(withSwitch('40px', '2rem'))).toEqual([
        'switchWidth and switchHeight must share a unit (the default is rem): 40px, 2rem',
      ]);
    });

    it('rejects em, zero, a track too short for its border and a width not above the height', () => {
      expect(validateThemeDefinition(withSwitch('2em', '1rem'))).toEqual([
        'Invalid appearance value for switchWidth: 2em',
      ]);
      expect(validateThemeDefinition(withSwitch('0', '1rem'))).toEqual([
        'Invalid appearance value for switchWidth: 0',
      ]);
      expect(validateThemeDefinition(withSwitch('32px', '4px'))).toEqual([
        'switchHeight must exceed the 4px track border: 4px',
      ]);
      expect(validateThemeDefinition(withSwitch('2rem', '0.25rem'))).toEqual([
        'switchHeight must be at least 0.5rem to clear the 4px track border: 0.25rem',
      ]);
      expect(validateThemeDefinition(withSwitch('1rem', '2rem'))).toEqual([
        'switchWidth must exceed switchHeight so the knob can travel: 1rem, 2rem',
      ]);
      expect(validateThemeDefinition(withSwitch('1.5rem', '1.5rem'))).toEqual([
        'switchWidth must exceed switchHeight so the knob can travel: 1.5rem, 1.5rem',
      ]);
    });
  });

  it('keeps the avatar backdrop on the surface each mode drew it on before the role existed', () => {
    const colors = { 'rgb-surface-secondary': '20 21 22', 'rgb-surface-tertiary': '30 31 32' };
    const theme = {
      version: 1 as const,
      name: 'legacy-avatar-placeholder',
      modes: { light: { colors }, dark: { colors } },
    };

    expect(resolveTheme(theme, 'light').colors['rgb-avatar-placeholder']).toBe('20 21 22');
    expect(resolveTheme(theme, 'dark').colors['rgb-avatar-placeholder']).toBe('30 31 32');
  });

  it('keeps the drawer edge on the drawer fill in light and the heavy border in dark', () => {
    const colors = { 'rgb-surface-primary-alt': '20 21 22', 'rgb-border-xheavy': '30 31 32' };
    const theme = {
      version: 1 as const,
      name: 'legacy-drawer-edge',
      modes: { light: { colors }, dark: { colors } },
    };
    const explicit = resolveTheme(
      {
        version: 1,
        name: 'explicit-drawer-edge',
        modes: {
          dark: { colors: { 'rgb-border-xheavy': '30 31 32', 'rgb-drawer-edge': '1 2 3' } },
        },
      },
      'dark',
    );

    expect(resolveTheme(theme, 'light').colors['rgb-drawer-edge']).toBe('20 21 22');
    expect(resolveTheme(theme, 'dark').colors['rgb-drawer-edge']).toBe('30 31 32');
    expect(explicit.colors['rgb-drawer-edge']).toBe('1 2 3');
  });

  it('inks the default avatar in the primary text a theme sets, unless it sets the role', () => {
    const inherited = resolveTheme(
      {
        version: 1,
        name: 'legacy-avatar-text',
        modes: { light: { colors: { 'rgb-text-primary': '10 11 12' } } },
      },
      'light',
    );
    const explicit = resolveTheme(
      {
        version: 1,
        name: 'explicit-avatar-text',
        modes: {
          light: { colors: { 'rgb-text-primary': '10 11 12', 'rgb-avatar-text': '1 2 3' } },
        },
      },
      'light',
    );

    expect(inherited.colors['rgb-avatar-text']).toBe('10 11 12');
    expect(explicit.colors['rgb-avatar-text']).toBe('1 2 3');
  });

  it('preserves an explicit avatar backdrop and falls back to the bundled one otherwise', () => {
    const explicit = resolveTheme(
      {
        version: 1,
        name: 'explicit-avatar-placeholder',
        modes: {
          dark: {
            colors: { 'rgb-surface-tertiary': '30 31 32', 'rgb-avatar-placeholder': '1 2 3' },
          },
        },
      },
      'dark',
    );
    const untouched = resolveTheme(
      { version: 1, name: 'no-surface', modes: { dark: { colors: {} } } },
      'dark',
    );

    expect(explicit.colors['rgb-avatar-placeholder']).toBe('1 2 3');
    expect(untouched.colors['rgb-avatar-placeholder']).toBe(darkTheme['rgb-avatar-placeholder']);
  });

  it('keeps the switch thumb on the surface a theme repainted before the role existed', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'legacy-switch-thumb',
        modes: { dark: { colors: { 'rgb-surface-primary': '20 21 22' } } },
      },
      'dark',
    );

    expect(resolved.colors['rgb-switch-thumb']).toBe('20 21 22');
  });

  it('preserves an explicit switch thumb and falls back to the bundled one otherwise', () => {
    const explicit = resolveTheme(
      {
        version: 1,
        name: 'explicit-switch-thumb',
        modes: {
          dark: { colors: { 'rgb-surface-primary': '20 21 22', 'rgb-switch-thumb': '1 2 3' } },
        },
      },
      'dark',
    );
    const untouched = resolveTheme(
      { version: 1, name: 'no-surface', modes: { dark: { colors: {} } } },
      'dark',
    );

    expect(explicit.colors['rgb-switch-thumb']).toBe('1 2 3');
    expect(untouched.colors['rgb-switch-thumb']).toBe(darkTheme['rgb-switch-thumb']);
  });

  it('keeps the tooltip and the error alert on the roles a theme repainted before they existed', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'legacy-overlays',
        modes: {
          light: {
            colors: {
              'rgb-surface-primary': '20 21 22',
              'rgb-text-primary': '1 2 3',
              'rgb-status-error-subtle': '4 5 6',
              'rgb-status-error-border': '7 8 9',
            },
          },
        },
      },
      'light',
    );

    expect(resolved.colors['rgb-surface-tooltip']).toBe('20 21 22');
    expect(resolved.colors['rgb-text-tooltip']).toBe('1 2 3');
    expect(resolved.colors['rgb-alert-error-fill']).toBe('4 5 6');
    expect(resolved.colors['rgb-alert-error-border']).toBe('7 8 9');
  });

  it('preserves an explicit tooltip surface and falls back to the bundled one otherwise', () => {
    const explicit = resolveTheme(
      {
        version: 1,
        name: 'explicit-tooltip',
        modes: {
          dark: { colors: { 'rgb-surface-primary': '20 21 22', 'rgb-surface-tooltip': '1 2 3' } },
        },
      },
      'dark',
    );
    const untouched = resolveTheme(
      { version: 1, name: 'no-surface', modes: { dark: { colors: {} } } },
      'dark',
    );

    expect(explicit.colors['rgb-surface-tooltip']).toBe('1 2 3');
    expect(untouched.colors['rgb-surface-tooltip']).toBe(darkTheme['rgb-surface-tooltip']);
  });

  it('keeps a self-sticking table header on the dialog surface a theme repainted', () => {
    const legacy = resolveTheme(
      {
        version: 1,
        name: 'legacy-table-fill',
        modes: { dark: { colors: { 'rgb-surface-dialog': '20 21 22' } } },
      },
      'dark',
    );

    expect(legacy.colors['rgb-table-header-fill']).toBe('20 21 22');
    expect(resolveTheme(libreChatTheme, 'dark').colors['rgb-table-header-fill']).toBe(
      darkTheme['rgb-surface-dialog'],
    );
  });

  it('keeps table column names on the secondary text a theme repainted', () => {
    const legacy = resolveTheme(
      {
        version: 1,
        name: 'legacy-table-header',
        modes: { light: { colors: { 'rgb-text-secondary': '20 21 22' } } },
      },
      'light',
    );
    const explicit = resolveTheme(
      {
        version: 1,
        name: 'explicit-table-header',
        modes: {
          light: { colors: { 'rgb-text-secondary': '20 21 22', 'rgb-table-header-text': '1 2 3' } },
        },
      },
      'light',
    );

    expect(legacy.colors['rgb-table-header-text']).toBe('20 21 22');
    expect(explicit.colors['rgb-table-header-text']).toBe('1 2 3');
  });

  it('keeps the light border a legacy theme drew its controls with', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'light-border-reference',
        modes: {
          light: { colors: { 'rgb-border-light': '110 111 112', 'rgb-border-medium': '90 91 92' } },
        },
      },
      'light',
    );

    expect(resolved.colors['rgb-border-control']).toBe('110 111 112');
  });

  it('keeps the medium border a legacy theme drew its selects with', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'medium-border-reference',
        modes: { dark: { colors: { 'rgb-border-medium': '150 151 152' } } },
      },
      'dark',
    );

    expect(resolved.colors['rgb-border-control']).toBe('150 151 152');
  });

  it('gives a theme that leaves every border alone the bundled control outline', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'surface-only-reference',
        modes: { dark: { colors: { 'rgb-surface-primary': '10 10 10' } } },
      },
      'dark',
    );

    expect(resolved.colors['rgb-border-control']).toBe(darkTheme['rgb-border-control']);
  });

  it('presses a theme that predates the pressed roles in the hover fills it painted', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'hover-only-reference',
        modes: {
          dark: {
            colors: {
              'rgb-surface-hover': '70 71 72',
              'rgb-surface-inverted-hover': '200 201 202',
            },
          },
        },
      },
      'dark',
    );

    expect(resolved.colors['rgb-surface-pressed']).toBe('70 71 72');
    expect(resolved.colors['rgb-surface-inverted-pressed']).toBe('200 201 202');
  });

  it('keeps the bundled pressed fills, equal to the bundled hovers, for a theme that paints none', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'pressless-reference',
        modes: { light: { colors: { 'rgb-accent-primary': '1 2 3' } } },
      },
      'light',
    );

    expect(resolved.colors['rgb-surface-pressed']).toBe(defaultTheme['rgb-surface-hover']);
    expect(resolved.colors['rgb-surface-inverted-pressed']).toBe(
      defaultTheme['rgb-surface-inverted-hover'],
    );
  });

  it('preserves explicit pressed fills over the hovers they would follow', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'pressed-reference',
        modes: {
          light: {
            colors: {
              'rgb-surface-hover': '10 20 30',
              'rgb-surface-pressed': '40 50 60',
              'rgb-surface-inverted-pressed': '70 80 90',
            },
          },
        },
      },
      'light',
    );

    expect(resolved.colors['rgb-surface-pressed']).toBe('40 50 60');
    expect(resolved.colors['rgb-surface-inverted-pressed']).toBe('70 80 90');
  });

  it('dims disabled controls unless a theme chooses to fill them', () => {
    const base = { version: 1, name: 'disabled-reference' } as const;

    expect(resolveTheme({ ...base, modes: {} }, 'light').appearance.disabledStyle).toBe('dim');
    expect(
      resolveTheme({ ...base, modes: { dark: { appearance: { disabledStyle: 'fill' } } } }, 'dark')
        .appearance.disabledStyle,
    ).toBe('fill');
    expect(
      validateThemeDefinition({
        ...base,
        modes: { light: { appearance: { disabledStyle: 'fade' as 'dim' } } },
      }),
    ).toEqual(['Invalid appearance value for disabledStyle: fade']);
  });

  it('sets headings in the UI family of a theme that names no display family', () => {
    const family = '"Reference Sans", sans-serif';
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'family-only-reference',
        modes: { light: { appearance: { fontFamily: family } } },
      },
      'light',
    );

    expect(resolved.appearance.displayFontFamily).toBe(family);
  });

  it('keeps an explicit display family and the bundled one for a theme that names neither', () => {
    const explicit = resolveTheme(
      {
        version: 1,
        name: 'display-reference',
        modes: {
          light: {
            appearance: { fontFamily: 'Body, sans-serif', displayFontFamily: 'Head, serif' },
          },
        },
      },
      'light',
    );
    const bundled = resolveTheme({ version: 1, name: 'fontless-reference', modes: {} }, 'dark');

    expect(explicit.appearance.displayFontFamily).toBe('Head, serif');
    expect(bundled.appearance.displayFontFamily).toBe(defaultAppearance.fontFamily);
  });

  it('pads theme-sized controls with the shared spacing by default', () => {
    expect(defaultAppearance.controlPaddingX).toBe(defaultAppearance.spaceNormal);
    expect(defaultAppearance.controlGap).toBe(defaultAppearance.spaceCompact);
  });

  it('keeps the controls of a theme that names only the shared spacing on it', () => {
    const { appearance } = resolveTheme(compactTheme, 'light');

    expect(appearance).toMatchObject({ controlPaddingX: '0.5rem', controlGap: '0.25rem' });
  });

  it('spaces controls apart from message rows when a theme names the control roles', () => {
    const { appearance } = resolveTheme(
      {
        version: 1,
        name: 'roomy-controls-reference',
        modes: {
          light: {
            appearance: { spaceNormal: '0.5rem', controlPaddingX: '2rem', controlGap: '1rem' },
          },
        },
      },
      'light',
    );

    expect(appearance).toMatchObject({
      spaceNormal: '0.5rem',
      spaceCompact: defaultAppearance.spaceCompact,
      controlPaddingX: '2rem',
      controlGap: '1rem',
    });
  });

  it('rejects a control spacing role that is not a length', () => {
    const issues = (appearance: Record<string, string>) =>
      validateThemeDefinition({
        version: 1,
        name: 'bad-controls',
        modes: { light: { appearance } },
      });

    expect(issues({ controlPaddingX: '1rem', controlGap: 'calc(1rem - 2px)' })).toEqual([]);
    expect(issues({ controlPaddingX: '12' })).toHaveLength(1);
    expect(issues({ controlGap: '1rem; color: red' })).toHaveLength(1);
  });

  it('keeps the primary buttons of a theme that predates the role on its inverted surface', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'inverted-reference',
        modes: { light: { colors: { 'rgb-surface-inverted': '10 20 30' } } },
      },
      'light',
    );

    expect(resolved.colors['rgb-button-primary']).toBe('10 20 30');
    expect(resolved.colors['rgb-button-primary-hover']).toBe(
      defaultTheme['rgb-button-primary-hover'],
    );
  });

  it('draws buttons from their own roles apart from the checkbox fill', () => {
    const { colors, appearance } = resolveTheme(
      {
        version: 1,
        name: 'bold-buttons-reference',
        modes: {
          dark: {
            colors: { 'rgb-button-primary': '200 30 90', 'rgb-button-primary-hover': '220 60 110' },
            appearance: {
              controlFontWeight: '700',
              buttonHeight: '3rem',
              buttonHeightSm: '2.75rem',
            },
          },
        },
      },
      'dark',
    );

    expect(colors['rgb-surface-inverted']).toBe(darkTheme['rgb-surface-inverted']);
    expect(colors['rgb-button-primary']).toBe('200 30 90');
    expect(appearance).toMatchObject({
      controlFontWeight: '700',
      buttonHeight: '3rem',
      buttonHeightSm: '2.75rem',
    });
  });

  it('keeps LibreChat’s button weight and heights by default', () => {
    expect(defaultAppearance).toMatchObject({
      controlFontWeight: '500',
      buttonHeight: '2.5rem',
      buttonHeightSm: '2.25rem',
    });
  });

  it('accepts a numeric label weight from 1 to 1000 and rejects anything else', () => {
    const issues = (controlFontWeight: string) =>
      validateThemeDefinition({
        version: 1,
        name: 'weights',
        modes: { light: { appearance: { controlFontWeight } } },
      });

    expect(issues('400')).toEqual([]);
    expect(issues('1000')).toEqual([]);
    ['0', '1001', 'bold', '400;', '4.5e2'].forEach((value) =>
      expect(issues(value)).toHaveLength(1),
    );
  });

  it('keeps badge labels on the primary ink of a theme that predates the role', () => {
    const light = resolveTheme(
      {
        version: 1,
        name: 'ink-reference',
        modes: { light: { colors: { 'rgb-text-primary': '10 20 30' } } },
      },
      'light',
    );
    const own = resolveTheme(
      {
        version: 1,
        name: 'badge-ink-reference',
        modes: { light: { colors: { 'rgb-badge-label': '200 30 90' } } },
      },
      'light',
    );

    expect(light.colors['rgb-badge-label']).toBe('10 20 30');
    expect(own.colors['rgb-badge-label']).toBe('200 30 90');
    expect(own.colors['rgb-text-primary']).toBe(defaultTheme['rgb-text-primary']);
  });

  it('keeps LibreChat’s dialog chrome by default', () => {
    expect(defaultAppearance).toMatchObject({
      dialogStroke: '0px',
      dialogPaddingX: '1.5rem',
      dialogHeaderGap: '0.375rem',
      dialogTitleSize: defaultAppearance.textLg,
      dialogTitleLeading: '1',
      dialogTitleFontWeight: '600',
      dialogTitleFontFamily: defaultAppearance.displayFontFamily,
    });
    expect(defaultTheme['rgb-dialog-title']).toBe(defaultTheme['rgb-text-primary']);
    expect(darkTheme['rgb-dialog-title']).toBe(darkTheme['rgb-text-primary']);
  });

  it('keeps the dialog titles of a theme that predates the roles on its type and ink', () => {
    const { colors, appearance } = resolveTheme(
      {
        version: 1,
        name: 'type-reference',
        modes: {
          light: {
            colors: { 'rgb-text-primary': '10 20 30' },
            appearance: { fontFamily: 'Georgia, serif', textLg: '1.4rem' },
          },
        },
      },
      'light',
    );

    expect(colors['rgb-dialog-title']).toBe('10 20 30');
    /** The family chains through the display role, which itself follows `fontFamily`. */
    expect(appearance.displayFontFamily).toBe('Georgia, serif');
    expect(appearance.dialogTitleFontFamily).toBe('Georgia, serif');
    expect(appearance.dialogTitleSize).toBe('1.4rem');
  });

  it('draws dialog chrome from its own roles apart from the type scale and body ink', () => {
    const { colors, appearance } = resolveTheme(
      {
        version: 1,
        name: 'framed-dialog-reference',
        modes: {
          dark: {
            colors: { 'rgb-dialog-title': '200 30 90' },
            appearance: {
              dialogStroke: '3px',
              dialogPaddingX: '3rem',
              dialogHeaderGap: '1rem',
              dialogTitleSize: '2rem',
              dialogTitleLeading: '1.2',
              dialogTitleFontWeight: '800',
              dialogTitleFontFamily: 'Georgia, serif',
            },
          },
        },
      },
      'dark',
    );

    expect(colors['rgb-text-primary']).toBe(darkTheme['rgb-text-primary']);
    expect(colors['rgb-dialog-title']).toBe('200 30 90');
    expect(appearance.textLg).toBe(defaultAppearance.textLg);
    expect(appearance.displayFontFamily).toBe(defaultAppearance.displayFontFamily);
    expect(appearance).toMatchObject({
      dialogStroke: '3px',
      dialogPaddingX: '3rem',
      dialogHeaderGap: '1rem',
      dialogTitleSize: '2rem',
      dialogTitleLeading: '1.2',
      dialogTitleFontWeight: '800',
      dialogTitleFontFamily: 'Georgia, serif',
    });
  });

  it('keeps LibreChat’s field and label by default', () => {
    expect(defaultAppearance).toMatchObject({
      fieldHeight: '2.5rem',
      fieldPaddingY: '0.5rem',
      fieldFocusStyle: 'ring',
      labelSize: defaultAppearance.textSm,
      labelLeading: '1',
      labelFontWeight: 'inherit',
    });
    expect(defaultTheme['rgb-border-field-focus']).toBe(defaultTheme['rgb-focus-control']);
    expect(darkTheme['rgb-border-field-focus']).toBe(darkTheme['rgb-focus-control']);
  });

  it('keeps the fields and labels of a theme that predates the roles on its focus and type', () => {
    const { colors, appearance } = resolveTheme(
      {
        version: 1,
        name: 'focus-reference',
        modes: {
          light: {
            colors: { 'rgb-text-primary': '10 20 30' },
            appearance: { textSm: '0.95rem' },
          },
        },
      },
      'light',
    );

    /** The field edge chains through `focus-control`, which itself follows the primary ink. */
    expect(colors['rgb-focus-control']).toBe('10 20 30');
    expect(colors['rgb-border-field-focus']).toBe('10 20 30');
    expect(appearance.labelSize).toBe('0.95rem');
    expect(appearance.fieldFocusStyle).toBe('ring');
  });

  it('draws fields and labels from their own roles apart from the focus ring and type scale', () => {
    const { colors, appearance } = resolveTheme(
      {
        version: 1,
        name: 'edge-focus-reference',
        modes: {
          dark: {
            colors: { 'rgb-border-field-focus': '200 30 90' },
            appearance: {
              fieldHeight: '3rem',
              fieldPaddingY: '0.75rem',
              fieldFocusStyle: 'border',
              labelSize: '1rem',
              labelLeading: '1.25',
              labelFontWeight: '700',
            },
          },
        },
      },
      'dark',
    );

    expect(colors['rgb-focus-control']).toBe(darkTheme['rgb-focus-control']);
    expect(colors['rgb-border-field-focus']).toBe('200 30 90');
    expect(appearance.textSm).toBe(defaultAppearance.textSm);
    expect(appearance).toMatchObject({
      fieldHeight: '3rem',
      fieldPaddingY: '0.75rem',
      fieldFocusStyle: 'border',
      labelSize: '1rem',
      labelLeading: '1.25',
      labelFontWeight: '700',
    });
  });

  describe('field fill and ink', () => {
    const fieldTheme = (modes: ThemeDefinition['modes']): ThemeDefinition => ({
      version: 1,
      name: 'field-fill-reference',
      modes,
    });

    it('keeps fields clear and inked in the primary text by default', () => {
      for (const mode of ['light', 'dark'] as const) {
        const { colors, appearance } = resolveTheme(fieldTheme({}), mode);
        const base = mode === 'dark' ? darkTheme : defaultTheme;
        expect(appearance.fieldFillStyle).toBe('transparent');
        expect(colors['rgb-field-text']).toBe(base['rgb-text-primary']);
        expect(colors['rgb-field-fill']).toBe(base['rgb-surface-primary']);
      }
    });

    it('keeps a theme that predates the roles on its own ink and canvas', () => {
      const { colors, appearance } = resolveTheme(
        fieldTheme({
          dark: { colors: { 'rgb-text-primary': '10 20 30', 'rgb-surface-primary': '40 50 60' } },
        }),
        'dark',
      );
      expect(colors['rgb-field-text']).toBe('10 20 30');
      expect(colors['rgb-field-fill']).toBe('40 50 60');
      expect(appearance.fieldFillStyle).toBe('transparent');
    });

    it('paints fields from their own roles when a theme names them', () => {
      const { colors, appearance } = resolveTheme(
        fieldTheme({
          light: {
            colors: { 'rgb-field-fill': '251 252 255', 'rgb-field-text': '48 46 50' },
            appearance: { fieldFillStyle: 'fill' },
          },
        }),
        'light',
      );
      expect(colors['rgb-field-fill']).toBe('251 252 255');
      expect(colors['rgb-field-text']).toBe('48 46 50');
      expect(colors['rgb-text-primary']).toBe(defaultTheme['rgb-text-primary']);
      expect(appearance.fieldFillStyle).toBe('fill');
    });

    it('rejects a fill style it does not know and a translucent field color', () => {
      const issues = (mode: ThemeDefinition['modes']['light']) =>
        validateThemeDefinition(fieldTheme({ light: mode }));
      expect(issues({ appearance: { fieldFillStyle: 'fill' } })).toEqual([]);
      expect(issues({ appearance: { fieldFillStyle: 'glass' as 'fill' } })).toEqual([
        'Invalid appearance value for fieldFillStyle: glass',
      ]);
      expect(issues({ colors: { 'rgb-field-fill': '1 2 3 / 0.5' } })).toHaveLength(1);
    });
  });

  it('rejects field and label values the shared validators refuse', () => {
    const issues = (appearance: Record<string, string>) =>
      validateThemeDefinition({
        version: 1,
        name: 'field-values',
        modes: { light: { appearance } },
      });

    expect(issues({ fieldFocusStyle: 'border', labelFontWeight: 'inherit' })).toEqual([]);
    [
      { fieldFocusStyle: 'glow' },
      { fieldHeight: 'tall' },
      { fieldPaddingY: '4' },
      { labelSize: '12' },
      { labelLeading: 'calc(1 / 0)' },
      { labelFontWeight: 'bold' },
    ].forEach((appearance) => expect(issues(appearance)).toHaveLength(1));
  });

  describe('appearance defaults that differ per mode', () => {
    const lightMenu = '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)';
    const darkMenu = '0 10px 15px -3px rgb(0 0 0 / 0.25), 0 4px 6px -4px rgb(0 0 0 / 0.1)';
    const lightTooltip = '0 2px 4px 0 rgb(0 0 0 / 0.25)';
    const darkTooltip = '0 1px 2px 0 rgb(0 0 0 / 0.35)';
    const shadows = (theme: ThemeDefinition, mode: 'light' | 'dark') => {
      const { menuShadow, tooltipShadow } = resolveTheme(theme, mode).appearance;
      return { menuShadow, tooltipShadow };
    };
    const theme = (modes: ThemeDefinition['modes']): ThemeDefinition => ({
      version: 1,
      name: 'mode-default-reference',
      modes,
    });

    it('publishes the per-mode defaults from the theme entry point', () => {
      expect(themeEntry.defaultAppearanceFor).toBe(defaultAppearanceFor);
      expect(themeEntry.darkAppearanceDefaults).toBe(darkAppearanceDefaults);
    });

    it('keeps the menu and tooltip shadows each mode drew before they had roles', () => {
      expect(shadows(theme({}), 'light')).toEqual({
        menuShadow: lightMenu,
        tooltipShadow: lightTooltip,
      });
      expect(shadows(theme({}), 'dark')).toEqual({
        menuShadow: darkMenu,
        tooltipShadow: darkTooltip,
      });
      expect(defaultAppearanceFor('light')).toBe(defaultAppearance);
      expect(defaultAppearanceFor('dark')).toEqual({
        ...defaultAppearance,
        ...darkAppearanceDefaults,
      });
    });

    it('shades light menus with a theme that names only shadowLg, and keeps the dark literal', () => {
      const shadowLg = '0 4px 6px -1px rgb(21 21 21 / 0.15)';
      const lgOnly = theme({
        light: { appearance: { shadowLg } },
        dark: { appearance: { shadowLg } },
      });

      expect(shadows(lgOnly, 'light').menuShadow).toBe(shadowLg);
      expect(shadows(lgOnly, 'dark').menuShadow).toBe(darkMenu);
    });

    it('applies a value named in one mode to that mode only', () => {
      const darkOnly = theme({
        dark: { appearance: { menuShadow: 'none', tooltipShadow: 'none' } },
      });

      expect(shadows(darkOnly, 'light')).toEqual({
        menuShadow: lightMenu,
        tooltipShadow: lightTooltip,
      });
      expect(shadows(darkOnly, 'dark')).toEqual({ menuShadow: 'none', tooltipShadow: 'none' });
    });

    it('lets a named menu shadow win over shadowLg in light', () => {
      const both = theme({
        light: { appearance: { shadowLg: '0 1px 2px 0 rgb(0 0 0 / 0.5)', menuShadow: 'none' } },
      });

      expect(shadows(both, 'light').menuShadow).toBe('none');
    });
  });

  it('keeps the menu, tooltip and tab corners on their old literals unless a theme names its own', () => {
    expect(defaultAppearance).toMatchObject({
      menuRadius: '0.7rem',
      tooltipRadius: '0.275rem',
      tabRadius: '0.185rem',
    });
    const corners = { menuRadius: '4px', tooltipRadius: '0.25rem', tabRadius: '0' };
    const { appearance } = resolveTheme(
      { version: 1, name: 'corner-reference', modes: { light: { appearance: corners } } },
      'light',
    );
    expect(appearance).toMatchObject(corners);
    expect(
      validateThemeDefinition({
        version: 1,
        name: 'corner-values',
        modes: { light: { appearance: { menuRadius: 'round' } } },
      }),
    ).toHaveLength(1);
  });

  it('keeps a 2px focus outline 2px off the edge unless a theme names its own', () => {
    expect(defaultAppearance).toMatchObject({ focusRingWidth: '2px', focusRingOffset: '2px' });
    const { appearance } = resolveTheme(
      {
        version: 1,
        name: 'focus-ring-reference',
        modes: { dark: { appearance: { focusRingWidth: '0.25rem', focusRingOffset: '-1px' } } },
      },
      'dark',
    );
    expect(appearance).toMatchObject({ focusRingWidth: '0.25rem', focusRingOffset: '-1px' });
  });

  it('keeps every control and icon size on the size it drew before it had a role', () => {
    expect(defaultAppearance).toMatchObject({
      iconSize: '1rem',
      iconSizeLg: '1.5rem',
      buttonHeightXs: '1.75rem',
      buttonHeightLg: '2.75rem',
      iconButtonSizeSm: '2rem',
      fieldHeightLg: '3rem',
      checkboxSize: '1rem',
      listMinWidth: '8rem',
      listMaxHeight: '24rem',
    });
  });

  it("bounds a Select list's width and scroll height", () => {
    const issues = (appearance: Record<string, string>) =>
      validateThemeDefinition({
        version: 1,
        name: 'list-values',
        modes: { light: { appearance } },
      });

    expect(issues({ listMinWidth: '0', listMaxHeight: '8rem' })).toEqual([]);
    expect(issues({ listMinWidth: '12rem', listMaxHeight: '640px' })).toEqual([]);
    [
      { listMinWidth: 'auto' },
      { listMinWidth: '-1rem' },
      { listMaxHeight: '0' },
      { listMaxHeight: '7rem' },
      { listMaxHeight: '41rem' },
      { listMaxHeight: '50vh' },
    ].forEach((appearance) => expect(issues(appearance)).toHaveLength(1));
  });

  it('rejects a pointer target under 24px and a size that is not a positive length', () => {
    const issues = (appearance: Record<string, string>) =>
      validateThemeDefinition({
        version: 1,
        name: 'size-values',
        modes: { light: { appearance } },
      });

    expect(
      issues({
        fieldHeightLg: '24px',
        checkboxSize: '1.5rem',
        iconSize: '20px',
        iconSizeLg: '2rem',
      }),
    ).toEqual([]);
    [
      { fieldHeightLg: '20px' },
      { fieldHeightLg: '1rem' },
      { fieldHeightLg: '1.5em' },
      { iconSize: '0' },
      { iconSize: '1.5rem' },
      { iconSize: '10px' },
      { iconSizeLg: '0.75rem' },
      { iconSizeLg: '40px' },
      { checkboxSize: '8px' },
      { checkboxSize: '2rem' },
      { checkboxSize: 'auto' },
      { buttonHeightLg: '-2rem' },
      { buttonHeightXs: '1px' },
      { iconSizeMd: '1rem' },
      { iconButtonSizeSm: '20px' },
      { iconButtonSizeSm: 'calc(2rem + 2px)' },
    ].forEach((appearance) => expect(issues(appearance)).toHaveLength(1));
  });

  it('rejects a focus outline that would vanish or is not a fixed length', () => {
    const issues = (appearance: Record<string, string>) =>
      validateThemeDefinition({
        version: 1,
        name: 'focus-ring-values',
        modes: { light: { appearance } },
      });

    expect(issues({ focusRingWidth: '3px', focusRingOffset: '0' })).toEqual([]);
    [
      { focusRingWidth: '0' },
      { focusRingWidth: '0px' },
      { focusRingWidth: '-2px' },
      { focusRingWidth: '2em' },
      { focusRingOffset: '2' },
      { focusRingOffset: 'calc(2px + 1px)' },
    ].forEach((appearance) => expect(issues(appearance)).toHaveLength(1));
  });

  it('does not count the dialog title ink among the surfaces the verified mark sits on', () => {
    const { colors } = resolveTheme(
      {
        version: 1,
        name: 'title-ink-reference',
        modes: { light: { colors: { 'rgb-dialog-title': '200 30 90' } } },
      },
      'light',
    );

    expect(colors['rgb-status-verified']).toBe(defaultTheme['rgb-status-verified']);
  });

  it('rejects dialog chrome values the shared validators refuse', () => {
    const issues = (appearance: Record<string, string>) =>
      validateThemeDefinition({
        version: 1,
        name: 'dialog-values',
        modes: { light: { appearance } },
      });

    expect(issues({ dialogStroke: '1px', dialogTitleLeading: '1.5' })).toEqual([]);
    [
      { dialogStroke: 'thin' },
      { dialogPaddingX: '2' },
      { dialogHeaderGap: 'red' },
      { dialogTitleSize: '1.25rem;' },
      { dialogTitleLeading: 'calc(1 / 0)' },
      { dialogTitleFontWeight: '1001' },
      { dialogTitleFontFamily: 'Inter; color: red' },
    ].forEach((appearance) => expect(issues(appearance)).toHaveLength(1));
  });

  it('reproduces Tailwind’s own type scale by default', () => {
    const tailwind = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'node_modules', 'tailwindcss', 'theme.css'),
      'utf8',
    );
    const steps = [
      ['xs', 'textXs', 'leadingXs'],
      ['sm', 'textSm', 'leadingSm'],
      ['base', 'textBase', 'leadingBase'],
      ['lg', 'textLg', 'leadingLg'],
      ['xl', 'textXl', 'leadingXl'],
      ['2xl', 'text2xl', 'leading2xl'],
    ] as const;
    const declared = (name: string) =>
      new RegExp(`--${name}:\\s*([^;]+);`).exec(tailwind)?.[1].trim();

    steps.forEach(([step, size, leading]) => {
      expect(defaultAppearance[size]).toBe(declared(`text-${step}`));
      expect(defaultAppearance[leading]).toBe(declared(`text-${step}--line-height`));
    });
  });

  it('keeps every bundled theme’s largest themed step below the unthemed text-3xl', () => {
    const rem = (value: string) => parseFloat(value);
    [
      defaultAppearance,
      { ...defaultAppearance, ...clickHouseTheme.modes.light?.appearance },
    ].forEach((appearance) => {
      expect(rem(appearance.text2xl)).toBeLessThan(1.875);
    });
  });

  it('accepts ratio and length line heights and rejects anything else', () => {
    const withLeading = (leadingSm: string): ThemeDefinition => ({
      version: 1,
      name: 'leading-reference',
      modes: { light: { appearance: { leadingSm } } },
    });

    expect(validateThemeDefinition(withLeading('1.5'))).toEqual([]);
    expect(validateThemeDefinition(withLeading('calc(1.25 / 0.875)'))).toEqual([]);
    expect(validateThemeDefinition(withLeading('1.25rem'))).toEqual([]);
    expect(validateThemeDefinition(withLeading('calc(1 / 0)'))).toEqual([
      'Invalid appearance value for leadingSm: calc(1 / 0)',
    ]);
    expect(validateThemeDefinition(withLeading('normal; color: red'))).toEqual([
      'Invalid appearance value for leadingSm: normal; color: red',
    ]);
  });

  it('accepts a scrim opacity from 0 to 1 and rejects anything else', () => {
    const withScrim = (scrimOpacity: string): ThemeDefinition => ({
      version: 1,
      name: 'scrim-reference',
      modes: { dark: { appearance: { scrimOpacity } } },
    });

    expect(validateThemeDefinition(withScrim('0.75'))).toEqual([]);
    expect(validateThemeDefinition(withScrim('1'))).toEqual([]);
    expect(validateThemeDefinition(withScrim('1.5'))).toEqual([
      'Invalid appearance value for scrimOpacity: 1.5',
    ]);
    expect(validateThemeDefinition(withScrim('75%'))).toEqual([
      'Invalid appearance value for scrimOpacity: 75%',
    ]);
  });

  it('draws the focus outline in the ring of a theme that predates the role', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'ring-only-reference',
        modes: { dark: { colors: { 'rgb-ring-primary': '200 210 220' } } },
      },
      'dark',
    );

    expect(resolved.colors['rgb-focus-outline']).toBe('200 210 220');
  });

  it('draws the control focus ring in the ink of a theme that predates the role', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'ink-only-reference',
        modes: { light: { colors: { 'rgb-text-primary': '20 30 40' } } },
      },
      'light',
    );

    expect(resolved.colors['rgb-focus-control']).toBe('20 30 40');
  });

  it('gives a theme that names neither the bundled focus roles', () => {
    const light = resolveTheme(
      {
        version: 1,
        name: 'focusless-reference',
        modes: { light: { colors: { 'rgb-accent-primary': '1 2 3' } } },
      },
      'light',
    );

    expect(light.colors['rgb-focus-outline']).toBe('0 0 0');
    expect(light.colors['rgb-focus-control']).toBe(defaultTheme['rgb-text-primary']);
  });

  it('preserves explicit focus roles over the ring and ink they would follow', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'focus-reference',
        modes: {
          light: {
            colors: {
              'rgb-ring-primary': '10 20 30',
              'rgb-text-primary': '40 50 60',
              'rgb-focus-outline': '200 0 120',
              'rgb-focus-control': '0 120 200',
            },
          },
        },
      },
      'light',
    );

    expect(resolved.colors['rgb-focus-outline']).toBe('200 0 120');
    expect(resolved.colors['rgb-focus-control']).toBe('0 120 200');
  });

  it('preserves an explicit control outline', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'explicit-control-border-reference',
        modes: {
          dark: { colors: { 'rgb-border-medium': '60 61 62', 'rgb-border-control': '70 71 72' } },
        },
      },
      'dark',
    );

    expect(resolved.colors['rgb-border-control']).toBe('70 71 72');
  });

  /** A deliberately different reference theme: it paints the whole seven-slot
   *  scale and its own surfaces, so it predates slot 8 and cannot name it.
   *  Falling back to the bundled indigo would paint a stop whose 3:1 mark
   *  contrast was only ever measured against LibreChat's surfaces. */
  const ownedScaleTheme: ThemeDefinition = {
    version: 1,
    name: 'owned-scale-reference',
    modes: {
      light: {
        colors: {
          'rgb-text-primary': '250 250 250',
          'rgb-text-secondary': '215 215 215',
          'rgb-surface-secondary': '18 18 24',
          'rgb-surface-tertiary': '30 30 38',
          'rgb-series-1': '120 200 255',
          'rgb-series-2': '255 160 90',
          'rgb-series-3': '110 230 210',
          'rgb-series-4': '240 200 100',
          'rgb-series-5': '250 150 200',
          'rgb-series-6': '190 160 255',
          'rgb-series-7': '130 220 120',
        },
      },
    },
  };

  it('derives an omitted eighth series slot from an owned scale’s neutral text', () => {
    const owned = resolveTheme(ownedScaleTheme, 'light');

    expect(owned.colors['rgb-series-8']).toBe('215 215 215');
    expect(owned.colors['rgb-series-7']).toBe('130 220 120');
  });

  it('derives it from the inherited text of an owned scale that names no text', () => {
    /** The same reference theme minus its text overrides: it repaints the scale
     *  and its surfaces but reads body copy in LibreChat's own colours, so the
     *  stop tracks the text it will actually sit beside instead of reverting to
     *  the bundled indigo. */
    const inheritedText = resolveTheme(
      {
        ...ownedScaleTheme,
        modes: {
          light: {
            colors: {
              'rgb-surface-secondary': '18 18 24',
              'rgb-surface-tertiary': '30 30 38',
              'rgb-series-1': '120 200 255',
              'rgb-series-7': '130 220 120',
            },
          },
        },
      },
      'light',
    );

    expect(inheritedText.colors['rgb-series-8']).toBe(defaultTheme['rgb-text-secondary']);
  });

  it('lets an owned scale name the eighth slot itself', () => {
    const named = resolveTheme(
      {
        ...ownedScaleTheme,
        modes: {
          light: {
            colors: { ...ownedScaleTheme.modes.light?.colors, 'rgb-series-8': '10 20 30' },
          },
        },
      },
      'light',
    );

    expect(named.colors['rgb-series-8']).toBe('10 20 30');
  });

  it('keeps the bundled eighth slot for a theme that paints no series colors', () => {
    expect(resolveTheme(compactTheme, 'dark').colors['rgb-series-8']).toBe(
      darkTheme['rgb-series-8'],
    );
    expect(resolveTheme(compactTheme, 'light').colors['rgb-series-8']).toBe(
      defaultTheme['rgb-series-8'],
    );
  });

  it('keeps the verified mark on the success fill a theme already named', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'legacy-verified-reference',
        modes: { dark: { colors: { 'rgb-status-success-strong': '8 135 89' } } },
      },
      'dark',
    );

    expect(resolved.colors['rgb-status-verified']).toBe('8 135 89');
  });

  it('keeps the verified mark on a success fill the theme only inherits', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'partial-verified-reference',
        modes: { dark: { colors: { 'rgb-surface-tertiary': '30 30 38' } } },
      },
      'dark',
    );

    expect(resolved.colors['rgb-status-verified']).toBe(darkTheme['rgb-status-success-strong']);
  });

  it('keeps the bundled verified fill for a theme with no colors of its own', () => {
    expect(resolveTheme(libreChatTheme, 'dark').colors['rgb-status-verified']).toBe(
      darkTheme['rgb-status-verified'],
    );
  });

  it('keeps the bundled verified fill for a theme that repaints nothing around the mark', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'unrelated-partial-reference',
        modes: { dark: { colors: { 'rgb-text-primary': '250 250 250' } } },
      },
      'dark',
    );

    expect(resolved.colors['rgb-status-verified']).toBe(darkTheme['rgb-status-verified']);
  });

  it('preserves an explicit verified fill', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'explicit-verified-reference',
        modes: {
          dark: {
            colors: {
              'rgb-status-success-strong': '8 135 89',
              'rgb-status-verified': '26 127 216',
            },
          },
        },
      },
      'dark',
    );

    expect(resolved.colors['rgb-status-verified']).toBe('26 127 216');
  });

  it('resolves provider brand tokens and lets a theme override them', () => {
    const defaults = resolveTheme(libreChatTheme, 'light');
    expect(defaults.brands['provider-anthropic']).toBe('#d09a74');
    expect(defaults.brands['provider-openai']).toBe(defaultBrands['provider-openai']);

    const custom = resolveTheme(
      {
        version: 1,
        name: 'white-label',
        modes: { light: {} },
        brands: { 'provider-anthropic': '#ffffff' },
      },
      'light',
    );
    expect(custom.brands['provider-anthropic']).toBe('#ffffff');
    expect(custom.brands['provider-openai']).toBe(defaultBrands['provider-openai']);
  });

  it('rejects CSS appended to a provider gradient', () => {
    expect(
      validateThemeDefinition({
        version: 1,
        name: 'invalid',
        modes: {},
        brands: {
          'provider-azure': 'linear-gradient(#000,#000), url(https://example.com/pixel)',
        },
      }),
    ).toContain(
      'Invalid brand value for provider-azure: linear-gradient(#000,#000), url(https://example.com/pixel)',
    );
  });

  it('rejects stacked CSS after a balanced gradient', () => {
    expect(
      validateThemeDefinition({
        version: 1,
        name: 'invalid',
        modes: {},
        brands: {
          'provider-azure':
            'linear-gradient(#000,#000), -webkit-image-set("https://example.com/pixel" 1x)',
        },
      }),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining('Invalid brand value for provider-azure')]),
    );
  });

  it('rejects a gradient for the provider foreground token', () => {
    expect(
      validateThemeDefinition({
        version: 1,
        name: 'invalid',
        modes: {},
        brands: {
          'provider-foreground': 'linear-gradient(#fff,#fff)',
        },
      }),
    ).toContain('Invalid brand value for provider-foreground: linear-gradient(#fff,#fff)');
  });

  it('preserves hover overrides from themes created before the composer hover token', () => {
    const storedTheme: ThemeDefinition = {
      version: 1,
      name: 'stored-theme',
      modes: {
        dark: {
          colors: { 'rgb-surface-hover': '44 45 46' },
        },
      },
    };

    const dark = resolveTheme(storedTheme, 'dark');

    expect(dark.colors['rgb-surface-hover']).toBe('44 45 46');
    expect(dark.colors['rgb-surface-composer-hover']).toBe('44 45 46');
  });

  it('reports invalid and unknown values before a definition reaches the DOM', () => {
    const invalidTheme = {
      version: 1,
      name: 'invalid',
      modes: {
        light: {
          colors: {
            'rgb-text-primary': '999 0 0',
            'rgb-unknown': 'red',
          },
          appearance: {
            controlRadius: 'url(theme.css)',
            shadowLg: '0 1px red; color: red',
            shadowMd: 'not-a-shadow',
            shadowXl: '1px red',
            shadow2xl: 'not-a-shadow var(--missing)',
            shadowXs: '0,',
            shadowSm: '0 2px 4px var(--brand-shadow)',
            shadow2xs: '0 env(safe-area-inset-tpo) 1px black',
            unknownSpacing: '1rem',
          },
        },
      },
    } as ThemeDefinition;

    expect(validateThemeDefinition(invalidTheme)).toEqual([
      'Invalid RGB value for rgb-text-primary: 999 0 0',
      'Invalid RGB value for rgb-unknown: red',
      'Invalid appearance value for controlRadius: url(theme.css)',
      'Invalid appearance value for shadowLg: 0 1px red; color: red',
      'Invalid appearance value for shadowMd: not-a-shadow',
      'Invalid appearance value for shadowXl: 1px red',
      'Invalid appearance value for shadow2xl: not-a-shadow var(--missing)',
      'Invalid appearance value for shadowXs: 0,',
      'Invalid appearance value for shadowSm: 0 2px 4px var(--brand-shadow)',
      'Invalid appearance value for shadow2xs: 0 env(safe-area-inset-tpo) 1px black',
    ]);
    expect(() => resolveTheme(invalidTheme, 'light')).toThrow(TypeError);
  });

  describe('appearance tokens this reader does not know', () => {
    const newerTheme = {
      version: 1,
      name: 'newer',
      modes: {
        light: {
          colors: { 'rgb-text-primary': '1 2 3' },
          appearance: { controlRadius: '2px', shadowTint: '0 1px 2px black' },
        },
        dark: { appearance: { futureSpacing: '3rem' } },
      },
      brands: { 'provider-openai': '#123456' },
    } as ThemeDefinition;

    it('resolves the rest of the definition and reports the unknown key', () => {
      expect(validateThemeDefinition(newerTheme)).toEqual([]);
      expect(collectThemeWarnings(newerTheme)).toEqual([
        'Unknown light appearance token ignored: shadowTint',
        'Unknown dark appearance token ignored: futureSpacing',
      ]);

      const light = resolveTheme(newerTheme, 'light');
      expect(light.colors['rgb-text-primary']).toBe('1 2 3');
      expect(light.appearance).toEqual({ ...defaultAppearance, controlRadius: '2px' });
      expect(light.brands['provider-openai']).toBe('#123456');
      expect(resolveTheme(newerTheme, 'dark').appearance).toEqual(defaultAppearanceFor('dark'));
    });

    it('reports nothing for a definition that only uses known tokens', () => {
      expect(collectThemeWarnings(compactTheme)).toEqual([]);
      expect(collectThemeWarnings(libreChatTheme)).toEqual([]);
    });

    it('still rejects an invalid value for a known key beside an unknown one', () => {
      const theme = {
        version: 1,
        name: 'mixed',
        modes: { light: { appearance: { controlRadius: 'huge', futureSpacing: '1rem' } } },
      } as ThemeDefinition;

      expect(validateThemeDefinition(theme)).toEqual([
        'Invalid appearance value for controlRadius: huge',
      ]);
      expect(() => resolveTheme(theme, 'light')).toThrow(TypeError);
    });

    it('ignores a colour token it does not know and paints the rest', () => {
      const theme = {
        version: 1,
        name: 'colour',
        modes: {
          light: {
            colors: {
              'rgb-future': '1 2 3',
              'surface-future': '7 8 9',
              'rgb-accent-primary': '4 5 6',
            },
            appearance: { futureSpacing: '1rem' },
          },
          dark: { colors: { 'rgb-surfce-primary': '1 1 1' } },
        },
      } as ThemeDefinition;

      expect(validateThemeDefinition(theme)).toEqual([]);
      expect(collectThemeWarnings(theme)).toEqual([
        'Unknown light color token ignored: rgb-future',
        'Unknown light color token ignored: surface-future',
        'Unknown light appearance token ignored: futureSpacing',
        'Unknown dark color token ignored: rgb-surfce-primary',
      ]);
      const resolved = resolveTheme(theme, 'light');
      expect(resolved.colors['rgb-accent-primary']).toBe('4 5 6');
      expect(resolved.colors).not.toHaveProperty('rgb-future');
      expect(resolved.colors).not.toHaveProperty('surface-future');
      expect(resolveTheme(theme, 'dark').colors).not.toHaveProperty('rgb-surfce-primary');
    });

    it('still rejects an unknown colour token with an invalid value or a malformed name', () => {
      const theme = {
        version: 1,
        name: 'colour',
        modes: {
          light: {
            colors: {
              'rgb-future': 'red',
              'surface-future': '300 0 0',
              'Surface Future': '1 2 3',
              'rgb-x;}': '1 2 3',
            },
          },
        },
      } as ThemeDefinition;

      expect(validateThemeDefinition(theme)).toEqual([
        'Invalid RGB value for rgb-future: red',
        'Invalid RGB value for surface-future: 300 0 0',
        'Unknown color token: Surface Future',
        'Unknown color token: rgb-x;}',
      ]);
      expect(collectThemeWarnings(theme)).toEqual([]);
      expect(() => resolveTheme(theme, 'light')).toThrow(TypeError);
    });

    it('still rejects an injection attempt carried by an unknown key', () => {
      const theme = {
        version: 1,
        name: 'injection',
        modes: {
          light: {
            appearance: {
              futureSpacing: '1rem; } body { display: none',
              futureImage: 'url(https://example.com/x.png)',
              futureMarkup: '</style><script>',
              futureObject: { nested: true },
              'future-name;}': '1rem',
              constructor: '1rem',
            },
          },
        },
      } as unknown as ThemeDefinition;

      expect(validateThemeDefinition(theme)).toEqual([
        'Invalid appearance value for futureSpacing: 1rem; } body { display: none',
        'Invalid appearance value for futureImage: url(https://example.com/x.png)',
        'Invalid appearance value for futureMarkup: </style><script>',
        'Invalid appearance value for futureObject: [object Object]',
        'Invalid appearance value for future-name;}: 1rem',
      ]);
      expect(() => resolveTheme(theme, 'light')).toThrow(TypeError);
    });
  });

  /** A caller may seed a theme from the exported defaults or round-trip a resolved theme. */
  it('accepts its own appearance defaults, calc() radii included', () => {
    const roundTrip = resolveTheme(
      { version: 1, name: 'seeded', modes: { light: { appearance: { ...defaultAppearance } } } },
      'light',
    );

    expect(roundTrip.appearance).toEqual(defaultAppearance);
    expect(
      validateThemeDefinition({
        version: 1,
        name: 'offsets',
        modes: {
          light: { appearance: { radiusSm: 'calc(1rem + 2px)', radiusMd: 'calc(4px - 0px)' } },
        },
      }),
    ).toEqual([]);
    expect(
      validateThemeDefinition({
        version: 1,
        name: 'nested',
        modes: {
          light: { appearance: { radiusSm: 'calc(1rem - var(--x))', radiusMd: 'calc(4px - 0)' } },
        },
      }),
    ).toEqual([
      'Invalid appearance value for radiusSm: calc(1rem - var(--x))',
      'Invalid appearance value for radiusMd: calc(4px - 0)',
    ]);
  });

  it('accepts the box-shadow forms a theme is likely to write', () => {
    const shadows = [
      'none',
      '0 1px 2px 0 rgb(0 0 0 / 0.05)',
      'inset 0 0 0 1px rgba(0, 0, 0, 0.1), 0 8px 16px -4px #00000033',
      '0 calc(0.25rem + 1px) 1ch -0.5vw rgb(0 0 0 / 0.1)',
      '0 0 #0000',
    ];

    shadows.forEach((shadowLg) => {
      expect(
        validateThemeDefinition({
          version: 1,
          name: 'shadows',
          modes: { light: { appearance: { shadowLg } } },
        }),
      ).toEqual([]);
    });
  });

  it('keeps accepting variable-backed surface elevation that released themes may hold', () => {
    const elevationSurface =
      '0 8px 16px rgb(var(--shadow-rgb) / 0.2), 0 env(safe-area-inset-top) 1px black';

    expect(
      validateThemeDefinition({
        version: 1,
        name: 'elevation',
        modes: { light: { appearance: { elevationSurface } } },
      }),
    ).toEqual([]);
    expect(
      validateThemeDefinition({
        version: 1,
        name: 'elevation',
        modes: { light: { appearance: { shadowLg: elevationSurface } } },
      }),
    ).toEqual([`Invalid appearance value for shadowLg: ${elevationSurface}`]);
  });

  it('sanitizes malformed legacy colors without weakening definition validation', () => {
    const legacyTheme = fromLegacyTheme(
      {
        'rgb-accent-primary': '1 2 3',
        'rgb-text-primary': 'invalid',
      },
      ' ',
    );

    expect(legacyTheme.name).toBe('custom');
    expect(legacyTheme.modes.light?.colors).toEqual({
      'rgb-accent-primary': '1 2 3',
    });

    const invalidTheme = {
      version: 1,
      name: 'invalid',
      modes: {
        light: {
          colors: { 'rgb-text-primary': null as never },
          appearance: { fontFamily: 42 as never },
        },
      },
    } as ThemeDefinition;

    expect(validateThemeDefinition(invalidTheme)).toEqual([
      'Invalid RGB value for rgb-text-primary: null',
      'Invalid appearance value for fontFamily: 42',
    ]);
  });

  it.each([
    [
      'mode collection arrays',
      { version: 1, name: 'invalid', modes: [] },
      'Theme modes must be an object',
    ],
    [
      'mode arrays',
      { version: 1, name: 'invalid', modes: { light: [] } },
      'Theme mode light must be an object',
    ],
    [
      'null modes',
      { version: 1, name: 'invalid', modes: { light: null } },
      'Theme mode light must be an object',
    ],
    [
      'color arrays',
      { version: 1, name: 'invalid', modes: { light: { colors: [] } } },
      'Theme colors for light must be an object',
    ],
    [
      'appearance arrays',
      { version: 1, name: 'invalid', modes: { light: { appearance: [] } } },
      'Theme appearance for light must be an object',
    ],
    [
      'unknown modes',
      { version: 1, name: 'invalid', modes: { sepia: {} } },
      'Unknown theme mode: sepia',
    ],
    [
      'unknown top-level fields',
      { version: 1, name: 'invalid', modes: {}, css: ':root {}' },
      'Unknown theme field: css',
    ],
    [
      'unknown mode fields',
      { version: 1, name: 'invalid', modes: { light: { appearence: {} } } },
      'Unknown light theme field: appearence',
    ],
  ])('rejects malformed runtime %s', (_label, definition, expectedError) => {
    expect(validateThemeDefinition(definition as ThemeDefinition)).toContain(expectedError);
    expect(() => resolveTheme(definition as ThemeDefinition, 'light')).toThrow(TypeError);
  });
});

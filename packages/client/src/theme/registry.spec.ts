import type { ThemeDefinition } from './types';
import {
  collectThemeWarnings,
  defaultAppearance,
  defaultBrands,
  fromLegacyTheme,
  libreChatTheme,
  resolveTheme,
  themeColorTokens,
  validateThemeDefinition,
} from './registry';
import { defaultTheme } from './themes/default';
import { darkTheme } from './themes/dark';

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
    expect(dark.appearance).toEqual(defaultAppearance);
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

  it('gives a theme that leaves the light border alone the bundled control outline', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'medium-border-reference',
        modes: {
          dark: {
            colors: { 'rgb-surface-primary': '10 10 10', 'rgb-border-medium': '150 151 152' },
          },
        },
      },
      'dark',
    );

    expect(resolved.colors['rgb-border-control']).toBe(darkTheme['rgb-border-control']);
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
            'rgb-unknown': '1 2 3',
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
      'Unknown color token: rgb-unknown',
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
      expect(resolveTheme(newerTheme, 'dark').appearance).toEqual(defaultAppearance);
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

    it('still rejects an unknown colour token', () => {
      const theme = {
        version: 1,
        name: 'colour',
        modes: {
          light: { colors: { 'rgb-future': '1 2 3' }, appearance: { futureSpacing: '1rem' } },
        },
      } as ThemeDefinition;

      expect(validateThemeDefinition(theme)).toEqual(['Unknown color token: rgb-future']);
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

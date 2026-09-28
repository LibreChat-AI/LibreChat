import type { IThemeRGB } from '../types';
import {
  HIGH_CONTRAST_THEME_NAME,
  defaultBrands,
  highContrastTheme,
  resolveTheme,
  themeBrandTokens,
  themeColorTokens,
  validateThemeDefinition,
} from '../registry';
import { highContrastDarkTheme, highContrastLightTheme } from './highContrast';

type Rgb = [number, number, number];

/** Brands are hex rather than channel triplets, so they need their own parser. */
function hexToRgb(value: string): Rgb {
  const hex = value.replace('#', '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((channel) => channel + channel)
          .join('')
      : hex.slice(0, 6);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG 1.4.6 enhanced contrast, the reason these modes exist. */
const WCAG_AAA_NORMAL = 7;
/** WCAG 1.4.11 non-text contrast, for borders, rings, marks and fills. */
const WCAG_NON_TEXT = 3;

/** Surfaces body copy renders on, including hover, which is transient and so
 *  carries no state-contrast duty of its own and can afford AAA text. */
const surfaces: Array<keyof IThemeRGB> = [
  'rgb-surface-primary',
  'rgb-chart-widget-surface',
  'rgb-surface-primary-alt',
  'rgb-surface-primary-contrast',
  'rgb-surface-secondary',
  'rgb-surface-secondary-alt',
  'rgb-surface-tertiary',
  'rgb-surface-tertiary-alt',
  'rgb-surface-dialog',
  'rgb-surface-chat',
  'rgb-presentation',
  'rgb-surface-hover',
  'rgb-surface-hover-alt',
  'rgb-surface-composer-hover',
  'rgb-header-primary',
  'rgb-header-hover',
  'rgb-header-button-hover',
];

/** The selected state. The fill no longer discharges WCAG 1.4.11 by itself: the
 *  contrast block rings every selected row and navigated menu item in
 *  `text-primary` at 21:1 (`html.high-contrast :is(...)` in
 *  `client/src/style.css`). That is what lets the fill stay light enough to
 *  carry an AAA label, which a fill dark enough to mark itself could not. */
const activeFills: Array<keyof IThemeRGB> = ['rgb-surface-active', 'rgb-surface-active-alt'];

const textTokens: Array<keyof IThemeRGB> = [
  'rgb-text-primary',
  'rgb-text-secondary',
  'rgb-text-secondary-alt',
  'rgb-text-tertiary',
  'rgb-text-muted',
];

/** Code blocks share the mode's own high-contrast canvas rather than a bundled
 * fallback that would reintroduce a grey surface. */
const codeSurfaces: Array<keyof IThemeRGB> = ['rgb-surface-code'];

const syntaxTokens: Array<keyof IThemeRGB> = [
  'rgb-syntax-text',
  'rgb-syntax-comment',
  'rgb-syntax-meta',
  'rgb-syntax-builtin',
  'rgb-syntax-keyword',
  'rgb-syntax-string',
  'rgb-syntax-attr',
  'rgb-syntax-title',
];

/** Painted with `text-text-on-status`, the per-mode label colour. Every feature
 *  call site reads that token; none hard-codes `text-white` any more. */
const solidFills: Array<keyof IThemeRGB> = [
  'rgb-surface-submit',
  'rgb-surface-submit-hover',
  'rgb-surface-destructive',
  'rgb-surface-destructive-hover',
  'rgb-status-success-strong',
  'rgb-status-info-strong',
  'rgb-status-warning-strong',
  'rgb-status-error-strong',
  'rgb-status-verified',
];

const borderTokens: Array<keyof IThemeRGB> = [
  'rgb-border-light',
  'rgb-border-medium',
  'rgb-border-medium-alt',
  'rgb-border-heavy',
  'rgb-border-xheavy',
  'rgb-border-destructive',
  'rgb-chart-widget-stroke',
  'rgb-ring-primary',
];

const accentTokens: Array<keyof IThemeRGB> = [
  'rgb-accent-primary',
  'rgb-accent-primary-hover',
  'rgb-link',
  'rgb-link-hover',
  'rgb-link-visited',
  'rgb-brand-purple',
];

const statusHues = ['success', 'info', 'warning', 'error', 'neutral'] as const;

function toRgb(theme: IThemeRGB, token: keyof IThemeRGB): Rgb {
  const parts = theme[token]?.trim().split(/\s+/).map(Number);
  if (parts?.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`theme token "${token}" is not an "R G B" triplet`);
  }
  return [parts[0], parts[1], parts[2]];
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function below(
  theme: IThemeRGB,
  minimum: number,
  foregrounds: Array<keyof IThemeRGB>,
  backgrounds: Array<keyof IThemeRGB>,
): string[] {
  return foregrounds.flatMap((foreground) =>
    backgrounds.flatMap((background) => {
      const ratio = contrast(toRgb(theme, foreground), toRgb(theme, background));
      return ratio < minimum
        ? [`${foreground} on ${background}: ${ratio.toFixed(2)}:1 (needs ${minimum}:1)`]
        : [];
    }),
  );
}

describe.each([
  ['high contrast light', highContrastLightTheme],
  ['high contrast dark', highContrastDarkTheme],
])('%s palette', (_name, theme: IThemeRGB) => {
  it('declares every registry token, so nothing falls back to a mid-grey default', () => {
    expect(Object.keys(theme).sort()).toEqual([...themeColorTokens].sort());
  });

  it('uses the mode canvas for code blocks instead of the stock grey', () => {
    const expected = theme === highContrastDarkTheme ? '0 0 0' : '255 255 255';
    const source =
      theme === highContrastDarkTheme
        ? theme['rgb-presentation']
        : theme['rgb-surface-primary-alt'];

    expect(theme['rgb-surface-code']).toBe(expected);
    expect(theme['rgb-surface-code']).toBe(source);
  });

  it('keeps neutral text at WCAG AAA on every canvas and hover fill', () => {
    expect(below(theme, WCAG_AAA_NORMAL, textTokens, surfaces)).toEqual([]);
  });

  it('keeps both shimmer stops at WCAG AAA on the page', () => {
    expect(
      below(
        theme,
        WCAG_AAA_NORMAL,
        ['rgb-shimmer-base', 'rgb-shimmer-dip'],
        ['rgb-surface-primary'],
      ),
    ).toEqual([]);
  });

  it('keeps the selected fill light enough for an AAA label', () => {
    expect(below(theme, WCAG_AAA_NORMAL, textTokens, activeFills)).toEqual([]);
  });

  /** The standard palettes are deliberately not held to this: their dark
   *  `syntax-attr` and `syntax-title` measure 3.71:1 and 3.99:1 on the code
   *  surface, a pre-existing gap that restyling every dark-mode code block
   *  inside a contrast PR would not be the right way to close. */
  it('keeps every syntax colour at WCAG AAA on the code surface', () => {
    expect(below(theme, WCAG_AAA_NORMAL, syntaxTokens, codeSurfaces)).toEqual([]);
  });

  it('keeps warning and destructive text at WCAG AAA on the page', () => {
    expect(
      below(
        theme,
        WCAG_AAA_NORMAL,
        ['rgb-text-warning', 'rgb-text-destructive'],
        ['rgb-surface-primary', 'rgb-surface-secondary', 'rgb-surface-dialog'],
      ),
    ).toEqual([]);
  });

  it('keeps every status hue at WCAG AAA against its own subtle fill', () => {
    const failures = statusHues.flatMap((hue) =>
      below(
        theme,
        WCAG_AAA_NORMAL,
        [`rgb-status-${hue}` as keyof IThemeRGB],
        [`rgb-status-${hue}-subtle` as keyof IThemeRGB],
      ),
    );
    expect(failures).toEqual([]);
  });

  it('keeps accents and links at WCAG AAA on the page', () => {
    expect(
      below(theme, WCAG_AAA_NORMAL, accentTokens, ['rgb-surface-primary', 'rgb-surface-secondary']),
    ).toEqual([]);
  });

  it('keeps inverted and fixed pairs at WCAG AAA', () => {
    expect(below(theme, WCAG_AAA_NORMAL, ['rgb-text-inverted'], ['rgb-surface-inverted'])).toEqual(
      [],
    );
    expect(
      below(theme, WCAG_AAA_NORMAL, ['rgb-text-inverted'], ['rgb-surface-inverted-hover']),
    ).toEqual([]);
    expect(
      below(
        theme,
        WCAG_AAA_NORMAL,
        ['rgb-text-fixed'],
        ['rgb-surface-fixed', 'rgb-surface-fixed-hover'],
      ),
    ).toEqual([]);
  });

  it('keeps borders and rings above the 3:1 non-text floor on every canvas', () => {
    expect(
      below(theme, WCAG_NON_TEXT, borderTokens, [
        'rgb-surface-primary',
        'rgb-surface-secondary',
        'rgb-surface-tertiary',
        'rgb-surface-dialog',
      ]),
    ).toEqual([]);
  });

  /** Each mode paints its fills on the far side of its own canvas, so the label
   *  ratio and the silhouette ratio are the same number and both reach AAA.
   *  Getting here is exactly what the per-mode `text-on-status` token buys: a
   *  literal white label would cap dark-mode fills at 6.66:1 with a 3.15:1
   *  silhouette, because those two would then pull in opposite directions. */
  it('keeps solid fills at WCAG AAA against both their label and the page', () => {
    expect(below(theme, WCAG_AAA_NORMAL, ['rgb-text-on-status'], solidFills)).toEqual([]);
    expect(below(theme, WCAG_AAA_NORMAL, solidFills, ['rgb-surface-primary'])).toEqual([]);
  });

  it('paints its status labels in the ink of the opposing canvas', () => {
    expect(theme['rgb-text-on-status']).toBe(
      theme === highContrastDarkTheme ? '0 0 0' : '255 255 255',
    );
  });

  /** The track is a UI component boundary under WCAG 1.4.11, and it has to stay
   *  distinct from the thumb riding on it and from the checked fill it swaps
   *  with, or the control loses its state as well as its outline. */
  it('keeps the unchecked switch track distinct from the page, thumb and checked fill', () => {
    expect(
      below(
        theme,
        WCAG_NON_TEXT,
        ['rgb-switch-unchecked'],
        ['rgb-surface-primary', 'rgb-surface-inverted'],
      ),
    ).toEqual([]);
  });

  it('never reuses a reserved status colour for series identity', () => {
    const reserved = new Set(
      statusHues.map((hue) => theme[`rgb-status-${hue}` as keyof IThemeRGB]),
    );
    for (let slot = 1; slot <= 7; slot += 1) {
      expect(reserved.has(theme[`rgb-series-${slot}` as keyof IThemeRGB])).toBe(false);
    }
  });
});

describe('high contrast theme definition', () => {
  it('resolves both modes without falling back to the standard palettes', () => {
    expect(resolveTheme(highContrastTheme, 'light').colors).toEqual(highContrastLightTheme);
    expect(resolveTheme(highContrastTheme, 'dark').colors).toEqual(highContrastDarkTheme);
    expect(resolveTheme(highContrastTheme, 'light').name).toBe(HIGH_CONTRAST_THEME_NAME);
  });

  it('inverts the canvas and the ink between its two modes', () => {
    expect(highContrastLightTheme['rgb-surface-primary']).toBe('255 255 255');
    expect(highContrastLightTheme['rgb-text-primary']).toBe('0 0 0');
    expect(highContrastDarkTheme['rgb-surface-primary']).toBe('0 0 0');
    expect(highContrastDarkTheme['rgb-text-primary']).toBe('255 255 255');
  });

  /** A provider avatar is a brand fill carrying a glyph, so it owes the same two
   *  ratios a status fill does: the glyph against the fill, and the fill against
   *  the canvas. The standard brand set leaves the white glyph at 2.30:1 on
   *  OpenAI green, which is why these are declared per mode. */
  it('keeps every provider avatar at WCAG AAA in both modes', () => {
    const providerFills = themeBrandTokens.filter((token) => token !== 'provider-foreground');

    (
      [
        ['light', '255 255 255'],
        ['dark', '0 0 0'],
      ] as const
    ).forEach(([mode, canvas]) => {
      const resolved = resolveTheme(highContrastTheme, mode);
      const glyph = hexToRgb(resolved.brands['provider-foreground']);
      const canvasRgb = canvas.split(' ').map(Number) as Rgb;

      providerFills.forEach((token) => {
        const fill = hexToRgb(resolved.brands[token]);
        expect({
          token: `${mode} ${token} glyph`,
          ratio: contrast(glyph, fill) >= WCAG_AAA_NORMAL,
        }).toEqual({ token: `${mode} ${token} glyph`, ratio: true });
        expect({
          token: `${mode} ${token} silhouette`,
          ratio: contrast(fill, canvasRgb) >= WCAG_AAA_NORMAL,
        }).toEqual({ token: `${mode} ${token} silhouette`, ratio: true });
      });
    });
  });

  it('lets a mode override the theme-wide brand set', () => {
    const themed = resolveTheme(
      {
        version: 1,
        name: 'per-mode-brands',
        modes: { dark: { brands: { 'provider-openai': '#123456' } } },
        brands: { 'provider-openai': '#abcdef' },
      },
      'dark',
    );
    expect(themed.brands['provider-openai']).toBe('#123456');

    const inherited = resolveTheme(
      {
        version: 1,
        name: 'per-mode-brands',
        modes: { dark: { brands: { 'provider-openai': '#123456' } } },
        brands: { 'provider-openai': '#abcdef' },
      },
      'light',
    );
    expect(inherited.brands['provider-openai']).toBe('#abcdef');
  });

  /** A key present with `undefined` is what `Partial` permits and what
   *  validation accepts, and every brand token is written to the DOM
   *  unconditionally, so spreading it would blank the avatar's fill. */
  it('falls back rather than blanking a brand set to undefined', () => {
    const resolved = resolveTheme(
      {
        version: 1,
        name: 'holes',
        modes: { dark: { brands: { 'provider-openai': undefined } } },
        brands: { 'provider-openai': '#abcdef', 'provider-anthropic': undefined },
      },
      'dark',
    );

    expect(resolved.brands['provider-openai']).toBe('#abcdef');
    expect(resolved.brands['provider-anthropic']).toBe(defaultBrands['provider-anthropic']);
    expect(Object.values(resolved.brands).every((value) => typeof value === 'string')).toBe(true);
  });

  it('validates a mode brand block the same way as the theme-wide one', () => {
    expect(
      validateThemeDefinition({
        version: 1,
        name: 'invalid',
        modes: { light: { brands: { 'provider-openai': 'rgb(var(--text-primary))' } } },
      }),
    ).toContain('Invalid brand value for provider-openai: rgb(var(--text-primary))');
    expect(
      validateThemeDefinition({
        version: 1,
        name: 'invalid',
        // @ts-expect-error the unknown token is the point of the assertion
        modes: { light: { brands: { 'provider-nope': '#000000' } } },
      }),
    ).toContain('Unknown brand token: provider-nope');
  });
});

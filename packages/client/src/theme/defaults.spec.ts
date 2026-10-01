import fs from 'fs';
import path from 'path';
import type { IThemeRGB } from './types';
import {
  defaultBrands,
  defaultAppearance,
  darkAppearanceDefaults,
  themeAppearanceProperties,
} from './registry';
import { defaultTheme } from './themes/default';
import { darkTheme } from './themes/dark';

const stylesheet = fs.readFileSync(path.resolve(__dirname, 'defaults.css'), 'utf8');

/** The declarations of the one top-level rule for `selector`, whitespace collapsed. */
function declarations(selector: string): Map<string, string> {
  const body = stylesheet.match(new RegExp(`^${selector.replace('.', '\\.')} \\{([^}]*)\\}`, 'm'));
  if (!body) {
    throw new Error(`defaults.css has no ${selector} rule`);
  }
  const withoutComments = body[1].replace(/\/\*[\s\S]*?\*\//g, '');
  return new Map(
    Array.from(withoutComments.matchAll(/(--[\w-]+):\s*([^;]+);/g), (match) => [
      match[1],
      match[2].replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim(),
    ]),
  );
}

const root = declarations(':root');
const light = declarations('html');
const dark = declarations('.dark');

/**
 * Tokens the stylesheet leaves undeclared on purpose, and the property the one rule that reads
 * each falls back to. The shimmer's bright stop follows the primary text color at the use site
 * in light mode, so a theme that sets only the text color still moves it.
 */
const useSiteFallbacks: Partial<Record<string, string>> = {
  '--shimmer-base': '--text-primary',
};

/** What `property` computes to on the root in a mode: `.dark` sits on the same element as `html`,
 *  so it inherits every declaration it does not restate. */
function resolve(property: string, isDark: boolean, seen: string[] = []): string | undefined {
  if (seen.includes(property)) {
    throw new Error(`defaults.css has a var() cycle: ${[...seen, property].join(' -> ')}`);
  }
  const value =
    (isDark ? dark.get(property) : undefined) ?? light.get(property) ?? root.get(property);
  if (value === undefined) {
    const fallback = useSiteFallbacks[property];
    return fallback === undefined ? undefined : resolve(fallback, isDark, [...seen, property]);
  }
  return value.replace(/var\((--[\w-]+)\)/g, (_match, reference: string) => {
    const resolved = resolve(reference, isDark, [...seen, property]);
    if (resolved === undefined) {
      throw new Error(`${property} reads ${reference}, which defaults.css never declares`);
    }
    return resolved;
  });
}

describe.each([
  ['light', defaultTheme, false],
  ['dark', darkTheme, true],
])('the %s stock palette', (_mode, theme: IThemeRGB, isDark: boolean) => {
  const tokens = Object.keys(theme) as Array<keyof IThemeRGB>;

  it('covers every registry color', () => {
    expect(tokens).toHaveLength(120);
  });

  it('resolves every registry color to the runtime theme value', () => {
    const drift = tokens.flatMap((token) => {
      const property = `--${token.slice(4)}`;
      const actual = resolve(property, isDark);
      return actual === theme[token] ? [] : [`${property}: css ${actual}, runtime ${theme[token]}`];
    });

    expect(drift).toEqual([]);
  });
});

/** Roles split out of a broader one alias it, so a stylesheet that sets only the broader role
 *  still reaches what the split role draws. */
const stockAliases: Partial<
  Record<keyof typeof defaultAppearance, keyof typeof defaultAppearance>
> = {
  controlPaddingX: 'spaceNormal',
  controlGap: 'spaceCompact',
  labelSize: 'textSm',
  dialogTitleSize: 'textLg',
  dialogTitleFontFamily: 'displayFontFamily',
  menuShadow: 'shadowLg',
};

/** Color roles split out of a broader one read it in the stylesheet, in both modes, so a
 *  stylesheet that overrides only the broader role still reaches what the split role paints. */
const colorAliases: Array<[string, string]> = [
  ['--button-primary', '--surface-inverted'],
  ['--button-primary-hover', '--surface-inverted-hover'],
  ['--dialog-title', '--text-primary'],
  ['--badge-label', '--text-primary'],
  ['--border-field-focus', '--focus-control'],
];

describe('the stock color aliases', () => {
  it.each(colorAliases)('declares %s as the %s it split from', (property, source) => {
    expect(light.get(property)).toBe(`var(${source})`);
    expect(dark.get(property) ?? light.get(property)).toBe(`var(${source})`);
  });
});

describe('the stock appearance and brands', () => {
  it('declares every appearance property with the registry default', () => {
    Object.entries(themeAppearanceProperties).forEach(([key, property]) => {
      const role = key as keyof typeof defaultAppearance;
      const value = defaultAppearance[role].replace(/\s+/g, ' ');
      const source = stockAliases[role];
      expect([property, light.get(property)]).toEqual([
        property,
        source ? `var(${themeAppearanceProperties[source]}, ${value})` : value,
      ]);
    });
  });

  it('declares the appearance defaults that differ in dark mode in the dark rule only', () => {
    Object.entries(darkAppearanceDefaults).forEach(([key, value]) => {
      const property = themeAppearanceProperties[key as keyof typeof defaultAppearance];
      expect([property, dark.get(property)]).toEqual([property, value?.replace(/\s+/g, ' ')]);
    });
    const darkOnly = [...dark.keys()].filter((property) => property.startsWith('--theme-'));
    expect(darkOnly.sort()).toEqual(
      Object.keys(darkAppearanceDefaults)
        .map((key) => themeAppearanceProperties[key as keyof typeof defaultAppearance])
        .sort(),
    );
  });

  it.each([
    ['light', false],
    ['dark', true],
  ])('declares every brand color with the registry default in %s', (_mode, isDark) => {
    Object.entries(defaultBrands).forEach(([token, value]) => {
      expect([token, resolve(`--${token}`, isDark)?.toLowerCase()]).toEqual([
        token,
        value.toLowerCase(),
      ]);
    });
  });
});

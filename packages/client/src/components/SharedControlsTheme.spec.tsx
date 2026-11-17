import '@testing-library/jest-dom';
import path from 'path';
import fsp from 'fs/promises';
import { compile } from 'tailwindcss';
import { deserialize, serialize } from 'v8';
import { render, screen } from '@testing-library/react';
import { resolveTheme, validateThemeDefinition, THEME_VERSION } from 'librechat-data-provider';
import type { ThemeDefinition } from 'librechat-data-provider';
import { applyResolvedTheme, clearAppliedTheme } from '../theme/utils/applyTheme';
import { ChoiceCards } from './ChoiceCards';
import { Button } from './Button';
import Radio from './Radio';

/** Tailwind's compiler clones its theme with `structuredClone`, which jsdom does not provide.
 *  V8 serialization is the same structured-clone algorithm Node's global uses. */
globalThis.structuredClone ??= <T,>(value: T): T => deserialize(serialize(value)) as T;

/** AGENTS.md requires a deliberately different reference theme for reusable new variants, to prove
 *  they follow theme data rather than the bundled LibreChat values. This one names every role the
 *  new controls read, with values the default theme never uses. */
const colors = {
  'surface-primary': '201 202 203',
  'surface-primary-alt': '211 212 213',
  'surface-secondary': '11 22 33',
  'surface-tertiary': '44 55 66',
  'surface-hover': '77 88 99',
  'text-primary': '111 122 133',
  'text-secondary': '144 155 166',
  'border-medium': '177 188 199',
  'focus-control': '5 6 7',
  'ring-primary': '8 9 10',
} as const;
type Role = keyof typeof colors;

const referenceTheme: ThemeDefinition = {
  version: THEME_VERSION,
  name: 'reference',
  modes: {
    light: {
      colors: Object.fromEntries(
        Object.entries(colors).map(([role, value]) => [`rgb-${role}`, value]),
      ),
      appearance: { buttonHeightXs: '2.25rem' },
    },
  },
};

const themeDirectory = path.resolve(__dirname, '../theme');

/** The stylesheet Tailwind generates for `candidates`, from the same entry the app builds with. */
async function generate(candidates: string[]) {
  const compiler = await compile(
    `@import 'tailwindcss';\n@import './tokens.css';\n@config '../../tailwind.preset.cjs';\n`,
    {
      base: themeDirectory,
      async loadModule(id: string, base: string) {
        const modulePath = id.startsWith('.') ? path.resolve(base, id) : require.resolve(id);
        const loaded = (await import(modulePath)) as { default?: unknown };
        return {
          base: path.dirname(modulePath),
          module: loaded.default ?? loaded,
          path: modulePath,
        };
      },
      async loadStylesheet(id: string, base: string) {
        const stylesheet =
          id === 'tailwindcss'
            ? path.join(path.dirname(require.resolve('tailwindcss/package.json')), 'index.css')
            : path.resolve(base, id);
        return {
          base: path.dirname(stylesheet),
          content: await fsp.readFile(stylesheet, 'utf8'),
          path: stylesheet,
        };
      },
    },
  );
  return compiler.build(candidates);
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeSelector = (value: string) => value.replace(/[^\w-]/g, (character) => `\\${character}`);

/** Follow `var()` the way the browser would: a property the theme set on the root wins, then the
 *  stylesheet's own declaration, then the fallback written in the `var()`. */
function resolveVariables(value: string, css: string): string {
  let result = value;
  for (let pass = 0; pass < 8 && result.includes('var('); pass++) {
    result = result.replace(
      /var\((--[\w-]+)(?:,\s*([^)]*))?\)/g,
      (_match, name: string, fallback?: string) => {
        const fromTheme = document.documentElement.style.getPropertyValue(name).trim();
        if (fromTheme) {
          return fromTheme;
        }
        const declared = new RegExp(`${escapeRegExp(name)}:\\s*([^;]+);`).exec(css)?.[1];
        return declared?.trim() ?? fallback?.trim() ?? '';
      },
    );
  }
  return result.replace(/\s+/g, ' ').trim();
}

/** What a utility declares for `property`, resolved against the applied theme. */
function paint(css: string, utility: string, property: string): string | undefined {
  const rule = new RegExp(`\\.${escapeRegExp(escapeSelector(utility))}[^{]*\\{([^}]*)\\}`).exec(
    css,
  );
  const declared = new RegExp(`(?:^|[\\s;{])${escapeRegExp(property)}:\\s*([^;}]+)`).exec(
    rule?.[1] ?? '',
  )?.[1];
  return declared === undefined ? undefined : resolveVariables(declared, css);
}

const PROPERTY = {
  bg: 'background-color',
  text: 'color',
  border: 'border-color',
  ring: '--tw-ring-color',
};

/** The color utilities a rendered control carries, as [utility, property, role]. */
function colorUtilities(container: HTMLElement) {
  const found = new Map<string, { property: string; role: Role }>();
  for (const element of container.querySelectorAll('[class]')) {
    for (const token of (element.getAttribute('class') ?? '').split(/\s+/)) {
      const match = /^(?:.*:)?(bg|text|border|ring)-(.+)$/.exec(token);
      if (match && match[2] in colors) {
        found.set(token, {
          property: PROPERTY[match[1] as keyof typeof PROPERTY],
          role: match[2] as Role,
        });
      }
    }
  }
  return [...found].map(([utility, { property, role }]) => ({ utility, property, role }));
}

/** The color a role must paint under the reference theme; a border role also carries its alpha. */
const expected = (role: Role) =>
  role.startsWith('border-') ? `rgb(${colors[role]} / 1)` : `rgb(${colors[role]})`;

async function expectReferencePaint(container: HTMLElement, minimum: number) {
  const utilities = colorUtilities(container);
  expect(utilities.length).toBeGreaterThanOrEqual(minimum);
  const css = await generate(utilities.map(({ utility }) => utility));
  for (const { utility, property, role } of utilities) {
    expect({ utility, painted: paint(css, utility, property) }).toEqual({
      utility,
      painted: expected(role),
    });
  }
}

const options = [
  { value: 'one', label: 'One', description: 'First', icon: <svg data-testid="icon-one" /> },
  { value: 'two', label: 'Two', description: 'Second', icon: <svg data-testid="icon-two" /> },
];

const scale = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
];

describe('the new shared controls under a reference theme', () => {
  beforeEach(() => {
    applyResolvedTheme(resolveTheme(referenceTheme, 'light'));
  });

  afterEach(() => {
    clearAppliedTheme();
  });

  it('is accepted by the registry and lands on the variables the controls read', () => {
    expect(validateThemeDefinition(referenceTheme)).toEqual([]);
    const root = document.documentElement;
    for (const [role, value] of Object.entries(colors)) {
      expect(root.style.getPropertyValue(`--${role}`)).toBe(value);
    }
    expect(root.style.getPropertyValue('--theme-button-height-xs')).toBe('2.25rem');
  });

  it('paints ChoiceCards, chosen and not, with the reference values', async () => {
    const { container } = render(
      <ChoiceCards options={options} value="one" onChange={() => {}} aria-label="Pick one" />,
    );
    /** The chosen card (primary-ink edge, secondary surface, tertiary icon tile and the mark), the
     *  other card (medium edge, hover surface, secondary icon tile) and the focus ring. */
    const utilities = colorUtilities(container).map(({ utility }) => utility);
    for (const utility of [
      'border-text-primary',
      'bg-surface-secondary',
      'bg-surface-tertiary',
      'border-border-medium',
      'hover:bg-surface-hover',
      'has-[:focus-visible]:ring-focus-control',
    ]) {
      expect(utilities).toContain(utility);
    }
    await expectReferencePaint(container, 8);
  });

  it('paints the raised Radio tone with the tertiary track and the alt pill', async () => {
    const { container } = render(
      <Radio options={scale} value="week" tone="raised" aria-labelledby="label" />,
    );
    const utilities = colorUtilities(container).map(({ utility }) => utility);
    expect(utilities).toContain('bg-surface-tertiary');
    expect(utilities).toContain('bg-surface-primary-alt');
    await expectReferencePaint(container, 2);
  });

  it('paints the section-add button, and sizes it from the button role', async () => {
    const { container } = render(
      <Button variant="section-add" aria-label="Add">
        Add
      </Button>,
    );
    const utilities = colorUtilities(container).map(({ utility }) => utility);
    for (const utility of [
      'text-text-secondary',
      'hover:bg-surface-secondary',
      'hover:text-text-primary',
      'focus-visible:ring-ring-primary',
    ]) {
      expect(utilities).toContain(utility);
    }
    await expectReferencePaint(container, 4);

    const button = screen.getByRole('button', { name: 'Add' });
    expect(button).toHaveClass('h-theme-button-xs');
    const css = await generate(['h-theme-button-xs']);
    expect(paint(css, 'h-theme-button-xs', 'height')).toBe('2.25rem');
  });
});

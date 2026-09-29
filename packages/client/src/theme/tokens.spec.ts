import fs from 'fs';
import path from 'path';
import fsp from 'fs/promises';
import { compile } from 'tailwindcss';
import { deserialize, serialize } from 'v8';
import { defaultTheme } from './themes/default';

/** Tailwind's compiler clones its theme with `structuredClone`, which jsdom does not provide.
 *  V8 serialization is the same structured-clone algorithm Node's global uses. */
globalThis.structuredClone ??= <T>(value: T): T => deserialize(serialize(value)) as T;

const tokensPath = path.resolve(__dirname, 'tokens.css');
const tokens = fs.readFileSync(tokensPath, 'utf8');
/** Each declared color token, mapped to the custom properties its value reads. */
const declarations = new Map(
  Array.from(
    tokens.matchAll(/--color-([\w-]+):([^;]+);/g),
    ([, name, value]) =>
      [name, Array.from(value.matchAll(/var\(--([\w-]+)/g), (match) => match[1])] as const,
  ).filter(([name]) => !name.endsWith('*')),
);
const declared = new Set(declarations.keys());

/**
 * Theme properties consumed by stylesheets rather than by utilities: the shimmer animation and
 * the code-syntax palette are set in CSS, so they carry no `bg-`/`text-` class and need no
 * Tailwind color token.
 */
const cssOnlyFamilies = /^(shimmer|syntax)-/;

async function generate(
  candidates: string[],
  entry = `@import 'tailwindcss';\n@import './tokens.css';\n@config '../../tailwind.preset.cjs';\n`,
) {
  const compiler = await compile(entry, {
    base: __dirname,
    async loadModule(id: string, base: string) {
      const modulePath = id.startsWith('.') ? path.resolve(base, id) : require.resolve(id);
      /** Tailwind hands this callback whatever `@config`/`@plugin` names, so the specifier is
       *  only known at runtime; a static import cannot express it. */
      const loaded = (await import(modulePath)) as { default?: unknown };
      return {
        base: path.dirname(modulePath),
        module: loaded.default ?? loaded,
        path: modulePath,
      };
    },
    async loadStylesheet(id: string, base: string) {
      /** Resolved through package.json: jest's moduleNameMapper turns a `.css` request into a
       *  style stub, which would hand Tailwind JavaScript to parse. */
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
  });

  return compiler.build(candidates);
}

describe('theme color tokens', () => {
  it('exposes every theme color the registry can set', () => {
    const missing = Object.keys(defaultTheme)
      .map((property) => property.replace(/^rgb-/, ''))
      .filter((token) => !cssOnlyFamilies.test(token) && !declared.has(token));

    expect(missing).toEqual([]);
  });

  it('lets a theme set every color token the stylesheet declares', () => {
    const registered = new Set(Object.keys(defaultTheme).map((key) => key.replace(/^rgb-/, '')));
    const unowned = [...declarations]
      .filter(([, reads]) => !reads.some((property) => registered.has(property)))
      .map(([token]) => token);

    expect(unowned).toEqual([]);
  });

  it('resolves a token to the custom property the theme rewrites at runtime', async () => {
    const css = await generate([
      'bg-surface-primary',
      'text-text-secondary',
      'bg-series-1',
      'bg-switch-thumb',
      'text-table-header-text',
      'bg-table-header-fill',
    ]);

    expect(css).toContain('rgb(var(--surface-primary))');
    expect(css).toContain('rgb(var(--text-secondary))');
    expect(css).toContain('rgb(var(--series-1))');
    expect(css).toContain('rgb(var(--switch-thumb, var(--surface-primary)))');
    expect(css).toContain('rgb(var(--table-header-text, var(--text-secondary)))');
    expect(css).toContain('rgb(var(--table-header-fill, var(--surface-dialog)))');
  });

  it('keeps a border token on its intrinsic alpha and still takes an opacity modifier', async () => {
    const css = await generate(['border-border-light', 'bg-surface-primary/50']);

    expect(css).toContain('rgb(var(--border-light) / var(--border-light-alpha, 1))');
    expect(css).toContain('color-mix(in oklab, rgb(var(--surface-primary)) 50%');
  });

  it.each(['./theme.css', '../../../../client/src/style.css'])(
    '%s preserves closed compatibility palettes without declaring them as semantic tokens',
    async (repositoryEntry) => {
      expect(declared.has('gray-650')).toBe(false);
      expect(declared.has('green-500')).toBe(false);

      const css = await generate(
        ['bg-gray-500', 'bg-gray-650', 'text-green-500', 'bg-gray-950', 'bg-green-950'],
        `@import '${repositoryEntry}';\n`,
      );

      expect(css).toMatch(/\.bg-gray-500\s*\{\s*background-color:\s*#595959;/);
      expect(css).toMatch(/\.bg-gray-650\s*\{\s*background-color:\s*#393939;/);
      expect(css).toMatch(/\.text-green-500\s*\{\s*color:\s*#10a37f;/);
      expect(css).not.toContain('.bg-gray-950');
      expect(css).not.toContain('.bg-green-950');
    },
  );
});

import fs from 'node:fs';
import v8 from 'node:v8';
import path from 'node:path';
import postcss, { AtRule, Rule } from 'postcss';
import type { ChildNode, Container, Result } from 'postcss';

/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const tailwindcss = require('@tailwindcss/postcss');

type FontDeclaration = { selector: string; value: string; important: boolean };

const selectorOf = (parent: Container<ChildNode> | undefined): string => {
  if (parent instanceof Rule) {
    return parent.selector;
  }
  if (parent instanceof AtRule) {
    return `@${parent.name} ${parent.params}`;
  }
  return '';
};

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** Replaces each `var(--name, fallback)` with the declared value of `--name`, or else its
 *  fallback, until none remain. A reference with neither is an error, not an empty string. */
const resolveVars = (value: string, properties: Map<string, string>, depth = 0): string => {
  const start = value.indexOf('var(');
  if (start === -1 || depth > 10) {
    return collapse(value);
  }
  let end = start + 4;
  for (let open = 1; open > 0; end++) {
    if (value[end] === '(') {
      open++;
    } else if (value[end] === ')') {
      open--;
    }
  }
  const inner = value.slice(start + 4, end - 1);
  const comma = inner.indexOf(',');
  const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
  const replacement = properties.get(name) ?? (comma === -1 ? undefined : inner.slice(comma + 1));
  if (replacement === undefined) {
    throw new Error(`${name} is referenced but never declared`);
  }
  return resolveVars(value.slice(0, start) + replacement + value.slice(end), properties, depth + 1);
};

const firstFamily = (value: string): string =>
  collapse(value.split(',')[0]).replace(/^['"]/, '').replace(/['"]$/, '');

/**
 * The code font is one decision: `--theme-mono-font-family` in `style.css`, mapped to
 * `--font-mono`, which Tailwind's preflight applies to `code`, `kbd`, `samp` and `pre`, and
 * which the `font-mono` utility carries. Both reach it through custom properties, so the
 * declarations are compared after resolving them.
 *
 * `style.css` used to restate that decision with `!important`. Because `!important` beats
 * specificity, one stylesheet rule outranked every `font-mono` class in the app and pinned
 * code to `Consolas, Söhne Mono, Monaco, …`: faces this repository does not ship, so code
 * rendered in Consolas on Windows and in Monaco on macOS, the latter carrying neither an
 * italic nor a bold face for the browser to use, hence synthesized ones.
 */
describe('code typography', () => {
  let fontFamilies: FontDeclaration[];

  beforeAll(async () => {
    /** Tailwind v4's compiler clones its AST with `structuredClone`, which Node has and
     *  jsdom, the environment this suite shares with the components, does not. */
    globalThis.structuredClone ??= <T>(value: T): T => v8.deserialize(v8.serialize(value));
    const file = path.join(__dirname, 'style.css');
    /** Inline sources rather than a scan of the tree, so the emitted utilities depend on
     *  the names asserted here and not on the working directory a runner happens to use. */
    const stylesheet = fs
      .readFileSync(file, 'utf8')
      .replace(
        "@import 'tailwindcss';",
        "@import 'tailwindcss' source(none);\n@source inline('font-mono font-sans');",
      );
    const compiled: Result = await postcss([tailwindcss({ base: __dirname })]).process(stylesheet, {
      from: file,
    });

    const properties = new Map<string, string>();
    compiled.root.walkDecls(/^--/, (declaration) => {
      properties.set(declaration.prop, declaration.value);
    });

    fontFamilies = [];
    compiled.root.walkDecls('font-family', (declaration) => {
      fontFamilies.push({
        selector: collapse(selectorOf(declaration.parent)),
        value: resolveVars(declaration.value, properties),
        important: declaration.important === true,
      });
    });
  }, 60_000);

  const utility = (): FontDeclaration | undefined =>
    fontFamilies.find((entry) => entry.selector === '.font-mono');

  it('declares no font-family that outranks a utility class', () => {
    expect(fontFamilies.filter((entry) => entry.important)).toEqual([]);
  });

  it('gives every bare code element the same stack as the font-mono utility', () => {
    const onCodeElements = fontFamilies.filter((entry) =>
      entry.selector
        .split(',')
        .map((part) => part.trim())
        .some((selector) => selector === 'code' || selector === 'pre'),
    );

    expect(utility()?.value).toBeTruthy();
    expect(onCodeElements).not.toHaveLength(0);
    for (const entry of onCodeElements) {
      expect(entry.value).toBe(utility()?.value);
    }
  });

  it('puts a self-hosted face first, so code renders the same on every platform', () => {
    const hosted = fontFamilies
      .filter((entry) => entry.selector.startsWith('@font-face'))
      .map((entry) => firstFamily(entry.value));

    expect(hosted).toContain(firstFamily(utility()?.value ?? ''));
  });
});

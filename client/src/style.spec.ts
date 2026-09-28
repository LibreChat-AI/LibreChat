import fs from 'node:fs';
import path from 'node:path';
import postcss, { AtRule, Rule } from 'postcss';
import type { ChildNode, Container, Result } from 'postcss';

/* eslint-disable @typescript-eslint/no-require-imports */
const tailwindcss = require('tailwindcss');
const tailwindConfig = require('../tailwind.config.cjs');
/* eslint-enable @typescript-eslint/no-require-imports */

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

const firstFamily = (value: string): string =>
  collapse(value.split(',')[0]).replace(/^['"]/, '').replace(/['"]$/, '');

/**
 * The code font is one decision: `theme.fontFamily.mono` in `tailwind.config.cjs`, which
 * Tailwind's preflight applies to `code`, `kbd`, `samp` and `pre`, and which the
 * `font-mono` utility carries.
 *
 * `style.css` used to restate that decision with `!important`. Because `!important` beats
 * specificity, one stylesheet rule outranked every `font-mono` class in the app and pinned
 * code to `Consolas, Söhne Mono, Monaco, …` — faces this repository does not ship, so code
 * rendered in Consolas on Windows and in Monaco on macOS, the latter carrying neither an
 * italic nor a bold face for the browser to use, hence synthesized ones.
 */
describe('code typography', () => {
  let fontFamilies: FontDeclaration[];

  beforeAll(async () => {
    const stylesheet = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
    /** Raw content rather than the config's globs, so the emitted utilities depend on the
     *  names asserted here and not on the working directory a runner happens to use. */
    const config = {
      ...tailwindConfig,
      content: [{ raw: 'font-mono font-sans', extension: 'html' }],
    };
    const compiled: Result = await postcss([tailwindcss(config)]).process(stylesheet, {
      from: undefined,
    });

    fontFamilies = [];
    compiled.root.walkDecls('font-family', (declaration) => {
      fontFamilies.push({
        selector: collapse(selectorOf(declaration.parent)),
        value: collapse(declaration.value),
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

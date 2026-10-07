import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { findCssColorLiterals } from './css-colors.mts';

const literals = (css: string): string[] => findCssColorLiterals(css).map(({ literal }) => literal);

test('reports hex, numeric colour functions and named colours in values', () => {
  const css = [
    'a {',
    '  color: #0066cc;',
    '  background-color: rgba(0, 0, 0, 0.1);',
    '  border-color: hsl(10 20% 30%);',
    '  outline: 1px solid white;',
    '  --accent: #FFF;',
    '}',
  ].join('\n');
  assert.deepEqual(literals(css), ['#0066cc', 'rgba(0', 'hsl(1', 'white', '#FFF']);
});

test('accepts theme variables, comments, urls and selectors', () => {
  const css = [
    '/* was #0066cc and rgba(0, 0, 0, 0.1) */',
    '#fade, #root { color: rgb(var(--text-primary)); }',
    'a {',
    '  background: rgb(var(--black) / 0.1);',
    '  box-shadow: 0 1px 2px rgb(var(--slate-ink) / 0.3);',
    '  --on-white: var(--white);',
    '  border-color: theme(colors.gray.200);',
    "  background-image: url('sprite.svg#fff');",
    "  content: 'white';",
    '  transition: color 150ms ease;',
    '}',
  ].join('\n');
  assert.deepEqual(literals(css), []);
});

test('reports the line of each finding', () => {
  assert.deepEqual(findCssColorLiterals('a {\n  color: red;\n}\n'), [{ line: 2, literal: 'red' }]);
});

test('exempts only the named rule, not the rest of its file', () => {
  const css = [
    '.azure-bg-color {',
    '  background: linear-gradient(0.375turn, #61bde2, #4389d0);',
    '}',
    '.other {',
    '  color: #0066cc;',
    '}',
  ].join('\n');
  assert.deepEqual(literals(css), ['#61bde2', '#4389d0', '#0066cc']);
  assert.deepEqual(findCssColorLiterals(css, [{ selector: '.azure-bg-color' }]), [
    { line: 5, literal: '#0066cc' },
  ]);
});

test('reads declarations that share a line with a selector or continue onto another line', () => {
  assert.deepEqual(literals('.alert { color: #fff; }'), ['#fff']);
  assert.deepEqual(literals('a{box-shadow:0 1px 2px\n  rgb(0 0 0 / 0.1)}'), ['rgb(0']);
  assert.deepEqual(literals('@media (min-width: 1px) { a { color: red } }'), ['red']);
});

test('matches colour functions case-insensitively, including color()', () => {
  assert.deepEqual(literals('a { color: color(srgb 1 0 0); }'), ['color(srgb 1']);
  assert.deepEqual(literals('a { background: RGB(255 0 0); }'), ['RGB(2']);
  assert.deepEqual(literals('a { color: color(from var(--x) srgb r g b); }'), []);
});

test('covers the full named-colour set and upper-case property names', () => {
  assert.deepEqual(literals('a { color: rebeccapurple; }'), ['rebeccapurple']);
  assert.deepEqual(literals('a { COLOR: red; }'), ['red']);
  assert.deepEqual(literals('a { transition: tan 1s; }'), []);
});

test('reads signed and keyword components and names in any colour-bearing shorthand', () => {
  assert.deepEqual(literals('a { color: hsl(-10 20% 30%); }'), ['hsl(-']);
  assert.deepEqual(literals('a { color: rgb(none 0 0); }'), ['rgb(none']);
  assert.deepEqual(literals('a { filter: drop-shadow(0 0 1px red); }'), ['red']);
  assert.deepEqual(literals('a { text-decoration: underline red; }'), ['red']);
  assert.deepEqual(literals('a { transition: color 1s; animation: white 1s; }'), []);
});

test('strips URL functions and escaped strings whole, and reads mixed variable components', () => {
  assert.deepEqual(literals('a { background-image: URL(#fff); }'), []);
  assert.deepEqual(literals('a { content: "a\\"; color: #fff;"; }'), []);
  assert.deepEqual(literals('a { color: hsl(var(--hue) 100% 50%); }'), ['hsl(var(--hue) 1']);
  assert.deepEqual(literals('a { color: hsl(var(--h) var(--s) var(--l)); }'), []);
});

test('reports each occurrence on its own line and reads calc() and mask gradients', () => {
  assert.deepEqual(
    findCssColorLiterals('a {\n  background: linear-gradient(\n    red,\n    red\n  );\n}'),
    [
      { line: 3, literal: 'red' },
      { line: 4, literal: 'red' },
    ],
  );
  assert.deepEqual(literals('a { color: rgb(calc(255) 0 0); }'), ['rgb(calc(']);
  assert.deepEqual(literals('a { mask: linear-gradient(red, blue); }'), ['red', 'blue']);
});

test('reads colours inside inline data images but not external urls', () => {
  const arrow =
    'a { background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg stroke=\'%238e8ea0\'/%3E"); }';
  assert.deepEqual(literals(arrow), ['#8e8ea0']);
  assert.deepEqual(literals('a { background-image: url(sprite.svg#fff); }'), []);
});

test('limits an exception to one property and decodes base64 images', () => {
  const css =
    "select { background-image: url('data:image/svg+xml;base64,PHN2ZyBzdHJva2U9JyNmZmYnLz4='); color: red; }";
  const allowed = [{ selector: 'select', property: 'background-image' }];
  assert.deepEqual(literals(css), ['#fff', 'red']);
  assert.deepEqual(findCssColorLiterals(css, allowed), [{ line: 1, literal: 'red' }]);
});

test('reads comma-separated components after var() and ignores comments inside values', () => {
  assert.deepEqual(literals('a { color: hsl(var(--h), 100%, 50%); }'), ['hsl(var(--h), 1']);
  assert.deepEqual(literals('a { color: var(--text) /* fallback: #fff */; }'), []);
});

test('reads every CSS math function as a colour channel', () => {
  assert.deepEqual(literals('a { color: rgb(min(255, 300) 0 0); }'), ['rgb(min(']);
  assert.deepEqual(literals('a { color: hsl(clamp(0, 120, 360) 100% 50%); }'), ['hsl(clamp(']);
});

test('reads numeric colour profiles, whole function names and later channels after variables', () => {
  assert.deepEqual(literals('a { color: color(display-p3 1 0 0); }'), ['color(display-p3 1']);
  assert.deepEqual(literals('a { --value: my-rgb(0); }'), []);
  assert.deepEqual(literals('a { color: rgb(var(--r) var(--g) 0); }'), ['rgb(var(--r) var(--g) 0']);
  assert.deepEqual(literals('a { color: rgb(var(--c) / 0.5); }'), []);
});

test('reads later channels in color() and inspects only SVG data images', () => {
  assert.deepEqual(literals('a { color: color(display-p3 var(--r) 0 0); }'), [
    'color(display-p3 var(--r) 0',
  ]);
  assert.deepEqual(literals("a { background: url('data:image/png;base64,cmVk'); }"), []);
});

test('blanks comments embedded in values', () => {
  assert.deepEqual(
    literals('a { background: linear-gradient(/* red to blue */ var(--a), var(--b)); }'),
    [],
  );
  assert.equal(literals('a { color: rgb(/* note */ 255 0 0); }').length, 1);
});

test('reads fixed channels in relative colours but not pure relative forms', () => {
  assert.equal(literals('a { color: rgb(from var(--base) 255 g b); }').length, 1);
  assert.deepEqual(literals('a { color: rgb(from var(--base) r g b / 0.5); }'), []);
});

test('reads numeric fallbacks inside a colour function var()', () => {
  assert.equal(literals('a { color: rgb(var(--brand, 255 0 0)); }').length, 1);
  assert.deepEqual(literals('a { color: rgb(var(--c) / var(--a, 1)); }'), []);
});

test('reads fixed channels in color(from) and every colour channel of a relative function', () => {
  assert.equal(literals('a { color: color(from var(--base) srgb r g 0); }').length, 1);
  assert.equal(literals('a { color: rgb(from var(--base) r 128 b); }').length, 1);
  assert.equal(literals('a { color: hsl(from var(--base) h none l); }').length, 1);
  assert.equal(literals('a { color: rgb(from var(--base) r g calc(255)); }').length, 1);
  assert.deepEqual(literals('a { color: color(from var(--base) srgb r g b / 0.5); }'), []);
  assert.deepEqual(literals('a { color: rgb(from var(--base) calc(r + 10) g b / 0.5); }'), []);
});

test('reads a channel triplet in a custom property', () => {
  assert.deepEqual(literals('a { --x: 255 0 0; }'), ['255 0 0']);
  assert.deepEqual(literals('a { --x: 0.5 0.2 1 / 0.4; }'), ['0.5 0.2 1 / 0.4']);
  assert.deepEqual(literals('a { --x: var(--a); --y: 1 2; --z: 0.5; }'), []);
  assert.deepEqual(literals('a { margin: 1 2 3; }'), []);
});

test('a token source exempts its custom properties only', () => {
  const css = ':root { --x: 255 0 0; --y: #fff; }\na { color: #fff; width: calc(1 * 2); }';
  assert.deepEqual(findCssColorLiterals(css, [], true), [{ line: 2, literal: '#fff' }]);
});

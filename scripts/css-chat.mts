/**
 * Writes the one stylesheet an app with no Tailwind of its own needs to draw `@librechat/chat`:
 * `packages/chat/dist/standalone.css`, published as `@librechat/chat/standalone.css`.
 *
 * It is compiled from what the two packages publish, the way an app with Tailwind would compile
 * it: the utilities their components name, built with `@librechat/client`'s preset and tokens,
 * then `@librechat/client/style.css` and `@librechat/chat/style.css`. Two things are then done to
 * it so it can sit in a page that is not LibreChat's:
 *
 *   - every rule that paints applies only inside an element with the `librechat` class, at no
 *     added specificity, so Tailwind's reset and class names such as `.table` or `.collapse`
 *     leave the rest of the page alone. Rules that only set custom properties are left as they
 *     are: the theme writes those on the document, and they paint nothing.
 *   - all of it sits in one cascade layer, `librechat`, so an app's own styles win without
 *     outranking a selector, and the app decides where the layer sorts.
 *
 * It fails, and writes nothing, when a class the packages use compiles differently here than in
 * LibreChat's own stylesheet, which is how a component comes to lean on the app's Tailwind setup.
 *
 *   node scripts/css-chat.mts [--out <file>] [--source <directory>]
 */

import postcss from 'postcss';
import { tmpdir } from 'node:os';
import tailwind from '@tailwindcss/postcss';
import { fileURLToPath } from 'node:url';
import { Features, transform } from 'lightningcss';
import { join, resolve, dirname } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import type { Selector, SelectorComponent } from 'lightningcss';
import type { AtRule, Root } from 'postcss';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHAT = resolve(ROOT, 'packages/chat');
const CLIENT = resolve(ROOT, 'packages/client');
const APP = resolve(ROOT, 'client');
/** The class an app puts on the element the chat renders in, and the layer the rules sit in. */
const NAME = 'librechat';
const TESTS = ['**/__tests__/**', '**/__fixtures__/**', '**/*.spec.*', '**/*.test.*'];

const quoted = (path: string): string => `'${path.replaceAll('\\', '/')}'`;

/** The `@source` lines naming what to read class names from, tests and fixtures aside. */
function sources(directories: string[]): string {
  return directories
    .flatMap((directory) => [
      `@source ${quoted(directory)};`,
      ...TESTS.map((pattern) => `@source not ${quoted(join(directory, pattern))};`),
    ])
    .join('\n');
}

async function compile(css: string, from: string): Promise<string> {
  const plugin = tailwind({ base: dirname(from), optimize: { minify: false } });
  return (await postcss([plugin]).process(css, { from })).css;
}

/** What an app with Tailwind is told to write, with the two packages as the only sources. */
function published(directories: string[]): string {
  return [
    '@layer theme, base, components, utilities;',
    "@import 'tailwindcss/theme.css' layer(theme);",
    "@import 'tailwindcss/preflight.css' layer(base);",
    "@import 'tailwindcss/utilities.css' layer(utilities) source(none);",
    `@import ${quoted(join(CLIENT, 'dist/tokens.css'))};`,
    `@import ${quoted(join(CLIENT, 'dist/style.css'))};`,
    `@import ${quoted(join(CHAT, 'src/style.css'))};`,
    `@config ${quoted(join(CLIENT, 'tailwind.preset.cjs'))};`,
    '@custom-variant dark (&:is(.dark *));',
    sources(directories),
  ].join('\n');
}

/**
 * LibreChat's own stylesheet, reading class names from the same sources and nothing of the app's.
 * Its Tailwind config lists the app's source as content, so a copy without that list stands in.
 */
async function app(directories: string[], scratch: string): Promise<string> {
  const from = join(APP, 'src/style.css');
  const config = join(scratch, 'tailwind.config.cjs');
  await writeFile(
    config,
    `module.exports = { ...require(${JSON.stringify(join(APP, 'tailwind.config.cjs'))}), content: [] };\n`,
  );
  const swaps: [string, string][] = [
    ["@import 'tailwindcss';", "@import 'tailwindcss' source(none);"],
    ["@config '../tailwind.config.cjs';", `@config ${quoted(config)};\n${sources(directories)}`],
  ];
  let css = await readFile(from, 'utf8');
  for (const [line, replacement] of swaps) {
    if (css.split(line).length !== 2) {
      throw new Error(`client/src/style.css no longer has the line \`${line}\` exactly once`);
    }
    css = css.replace(line, replacement);
  }
  return compile(css, from);
}

/** Each utility rule of a compiled stylesheet under the conditions it applies in, and each animation. */
function utilities(css: string): Map<string, string> {
  const rules = new Map<string, string>();
  const squeeze = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const root = postcss.parse(css);
  root.walkAtRules('keyframes', (keyframes) => {
    rules.set(`@keyframes ${keyframes.params}`, squeeze(keyframes.nodes?.join(' ') ?? ''));
  });
  root.walkRules((rule) => {
    const conditions: string[] = [];
    let layer = '';
    for (let parent = rule.parent; parent != null; parent = parent.parent as typeof parent) {
      if (parent.type !== 'atrule') continue;
      const at = parent as AtRule;
      if (at.name === 'keyframes') return;
      if (at.name === 'layer') layer = at.params;
      else conditions.unshift(`@${at.name} ${at.params}`);
    }
    if (layer !== 'utilities') return;
    const key = squeeze([...conditions, rule.selector].join(' '));
    const body = rule.nodes.map((node) => squeeze(node.toString())).join('; ');
    rules.set(key, [rules.get(key), body].filter(Boolean).join('; '));
  });
  return rules;
}

/** What the packages' classes compile to here and not, or not the same, in the app's stylesheet. */
function differences(ours: Map<string, string>, theirs: Map<string, string>): string[] {
  const found: string[] = [];
  for (const [key, body] of ours) {
    const other = theirs.get(key);
    if (key.startsWith('@keyframes ') ? other != null && other !== body : other !== body) {
      found.push(`${key}\n    here: ${body}\n    app:  ${other ?? '(nothing)'}`);
    }
  }
  for (const [key, body] of theirs) {
    if (!key.startsWith('@keyframes ') && !ours.has(key)) {
      found.push(`${key}\n    here: (nothing)\n    app:  ${body}`);
    }
  }
  return found;
}

const INSIDE: SelectorComponent = {
  type: 'pseudo-class',
  kind: 'where',
  selectors: [
    [{ type: 'class', name: NAME }],
    [
      { type: 'class', name: NAME },
      { type: 'combinator', value: 'descendant' },
      { type: 'universal' },
    ],
  ],
};
const ITSELF: Selector = [
  { type: 'pseudo-class', kind: 'where', selectors: [[{ type: 'class', name: NAME }]] },
];

/** `html`, `body`, `:root` or `:host` alone: the page, which here is the element with the class. */
function isPage(selector: Selector): boolean {
  if (selector.length !== 1) return false;
  const [component] = selector;
  if (component.type === 'type') return component.name === 'html' || component.name === 'body';
  return (
    component.type === 'pseudo-class' && (component.kind === 'root' || component.kind === 'host')
  );
}

/** The selector, matching only what is inside the class: the condition goes on its subject. */
function within(selector: Selector): Selector {
  if (selector.some((component) => component.type === 'nesting')) return selector;
  if (isPage(selector)) return ITSELF;
  const subject = selector.findLastIndex((component) => component.type === 'combinator') + 1;
  const pseudo = selector.findIndex(
    (component, index) => index >= subject && component.type === 'pseudo-element',
  );
  const at = pseudo === -1 ? selector.length : pseudo;
  return [...selector.slice(0, at), INSIDE, ...selector.slice(at)];
}

/**
 * Holds every rule that paints to the inside of the class, with Tailwind's own optimizer settings.
 * A rule is visited before its selectors, and a rule cannot be handed back changed: a declaration
 * that reads a custom property does not survive the round trip.
 */
function scope(css: string): string {
  let paints = false;
  const { code } = transform({
    filename: 'standalone.css',
    code: Buffer.from(css),
    minify: false,
    drafts: { customMedia: true },
    nonStandard: { deepSelectorCombinator: true },
    include: Features.Nesting | Features.MediaQueries,
    exclude: Features.LogicalProperties | Features.DirSelector | Features.LightDark,
    targets: {
      safari: (16 << 16) | (4 << 8),
      ios_saf: (16 << 16) | (4 << 8),
      firefox: 128 << 16,
      chrome: 111 << 16,
    },
    errorRecovery: true,
    visitor: {
      Rule: {
        style(rule) {
          const { declarations, importantDeclarations } = rule.value.declarations;
          /** `custom` is also how a property this parser has no model for arrives. */
          paints = [...(declarations ?? []), ...(importantDeclarations ?? [])].some(
            (declaration) =>
              declaration.property !== 'custom' || !declaration.value.name.startsWith('--'),
          );
        },
      },
      Selector: (selector) => (paints ? within(selector) : selector),
    },
  });
  return code.toString();
}

/**
 * Puts the stylesheet in its layer. A font face and a registered property are not layered, and
 * `html` and `:host` in one rule have become the same selector twice.
 */
function layer(css: string): Root {
  const root = postcss.parse(css);
  const wrapper = postcss.atRule({ name: 'layer', params: NAME });
  root.walkRules((rule) => {
    rule.selectors = [...new Set(rule.selectors)];
  });
  for (const node of [...root.nodes]) {
    const global =
      node.type === 'atrule' && (node.name === 'property' || node.name === 'font-face');
    if (!global) wrapper.append(node.remove());
  }
  root.prepend(wrapper);
  return root;
}

function option(name: string): string | undefined {
  const flag = process.argv.indexOf(name);
  return flag === -1 ? undefined : process.argv[flag + 1];
}

async function main(): Promise<void> {
  const out = resolve(option('--out') ?? join(CHAT, 'dist/standalone.css'));
  const extra = option('--source');
  const directories = [join(CHAT, 'src'), join(CLIENT, 'src'), ...(extra ? [resolve(extra)] : [])];

  const scratch = await mkdtemp(join(tmpdir(), 'librechat-css-'));
  let compiled: string;
  let reference: string;
  try {
    [compiled, reference] = await Promise.all([
      compile(published(directories), join(CHAT, 'standalone.css')),
      app(directories, scratch),
    ]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const found = differences(utilities(compiled), utilities(reference));
  if (found.length > 0) {
    throw new Error(
      `${found.length} rule(s) for classes the packages use compile differently from ` +
        `@librechat/client's preset and tokens than in LibreChat's own stylesheet:\n` +
        found.map((difference) => `  ${difference}`).join('\n'),
    );
  }

  const sheet = layer(scope(compiled));
  let rules = 0;
  sheet.walkRules(() => {
    rules += 1;
  });
  const banner =
    '/* @librechat/chat, compiled for an app without Tailwind. Generated by scripts/css-chat.mts:\n' +
    ` * every rule that paints applies inside \`.${NAME}\` and sits in the \`${NAME}\` layer. */\n`;
  const css = `${banner}${sheet.toString()}\n`;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, css);
  console.log(`@librechat/chat: ${rules} rules, ${Math.round(css.length / 1024)} kB -> ${out}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

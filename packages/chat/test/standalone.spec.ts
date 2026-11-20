import postcss from 'postcss';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import type { Root, Rule } from 'postcss';

/**
 * What `@librechat/chat/standalone.css` holds, written by the step that builds it: the one
 * stylesheet an app with no Tailwind of its own loads to draw the package.
 */
const SCRIPT = resolve(__dirname, '../../../scripts/css-chat.mts');
const INSIDE = ':where(.librechat, .librechat *)';
const ITSELF = ':where(.librechat)';

const scratch = mkdtempSync(join(tmpdir(), 'chat-css-'));
const generate = (...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

/** Every rule outside an animation's frames that sets something other than a custom property. */
function painting(root: Root): Rule[] {
  const rules: Rule[] = [];
  root.walkRules((rule) => {
    for (let parent = rule.parent; parent != null; parent = parent.parent as typeof parent) {
      if (parent.type === 'atrule' && 'name' in parent && parent.name === 'keyframes') {
        return;
      }
    }
    if (rule.some((node) => node.type === 'decl' && !node.prop.startsWith('--'))) {
      rules.push(rule);
    }
  });
  return rules;
}

describe('the stylesheet for an app without Tailwind', () => {
  const file = join(scratch, 'standalone.css');
  let root: Root;
  let selectors: string[];

  beforeAll(() => {
    const run = generate('--out', file);
    if (run.status !== 0) {
      throw new Error(run.stderr);
    }
    root = postcss.parse(readFileSync(file, 'utf8'));
    selectors = painting(root).flatMap((rule) => rule.selectors);
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('sits in one layer, fonts and registered properties aside', () => {
    const kinds = root.nodes.map((node) => (node.type === 'atrule' ? `@${node.name}` : node.type));
    expect(new Set(kinds)).toEqual(new Set(['comment', '@layer', '@font-face', '@property']));
    const layers = root.nodes.filter((node) => node.type === 'atrule' && node.name === 'layer');
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({ params: 'librechat' });
  });

  it('paints nothing outside the element that carries the class', () => {
    expect(selectors.length).toBeGreaterThan(1500);
    expect(
      selectors.filter((selector) => selector !== ITSELF && !selector.includes(INSIDE)),
    ).toEqual([]);
  });

  it('puts the condition on what a rule styles, and leaves what it looks up at alone', () => {
    /** Tailwind's reset, which would otherwise restyle the whole page. */
    expect(selectors).toContain(INSIDE);
    expect(selectors).toContain(`button${INSIDE}`);
    /** The page's own line height and family, on the element the chat renders in. */
    expect(selectors).toContain(ITSELF);
    expect(selectors).not.toContain('html');
    /** A pseudo-element stays last, and an ancestor such as the dark class stays where it is. */
    expect(selectors).toContain(`${INSIDE}::placeholder`);
    expect(selectors).toContain(`.prose li${INSIDE}::marker`);
    expect(selectors).toContain(`html.high-contrast .markdown th${INSIDE}`);
    expect(selectors).toContain(`.dark\\:opacity-25:is(.dark *)${INSIDE}`);
    expect(selectors).toContain(`.group-hover\\:opacity-100:is(:where(.group):hover *)${INSIDE}`);
  });

  it('adds no specificity: the condition is only ever a :where()', () => {
    const others = selectors
      .map((selector) => selector.split(INSIDE).join('').split(ITSELF).join(''))
      .filter((selector) => selector.includes('librechat'));
    expect(others).toEqual([]);
  });

  it('leaves the theme’s custom properties where the theme writes them', () => {
    const defaults: string[] = [];
    root.walkDecls('--text-primary', (decl) => {
      defaults.push((decl.parent as Rule).selector);
    });
    expect(defaults).toEqual(expect.arrayContaining(['html', '.dark']));
    expect(defaults.join(' ')).not.toContain('librechat');
  });

  it.each([
    ['a utility the components name', '.flex'],
    ['a color role from the tokens', '.bg-surface-primary'],
    ['the typography', '.prose'],
    ['the message body', '.message-content'],
    ['the client package’s parts', '.popover-ui'],
    ['this package’s own rules', '.message-render'],
  ])('carries %s', (_what, name) => {
    expect(selectors.some((selector) => selector.startsWith(`${name}${INSIDE}`))).toBe(true);
  });

  it('fails, and writes nothing, when a class compiles differently than in the app', () => {
    const source = join(scratch, 'source');
    const out = join(scratch, 'refused.css');
    mkdirSync(source);
    /** The app's own gray scale, and an animation only the app's Tailwind config defines. */
    writeFileSync(
      join(source, 'Leaning.tsx'),
      "export const leaning = 'bg-gray-500 animate-logo-blink';\n",
    );
    const run = generate('--out', out, '--source', source);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('.bg-gray-500');
    expect(run.stderr).toContain('.animate-logo-blink');
    expect(existsSync(out)).toBe(false);
  });
});

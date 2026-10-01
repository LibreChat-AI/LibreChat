import { join } from 'path';
import { readFileSync } from 'fs';

/**
 * The ten named primitives, read the strict way: a primitive is theme-driven only when its files
 * paint color, radius, border, shadow and size from theme roles alone. Each file is checked for
 * raw palette utilities, hex/rgb/hsl literals, arbitrary corners and shadows, fixed size
 * utilities (`h-4`, `size-10`; a fraction such as `w-11/12` is a proportion, not a size), literal
 * corners and shadows in its stylesheet, and design-rule suppressions. Move a primitive into
 * `themeDriven` when a change clears it; the remaining values of the others are pinned so a new
 * literal fails by name.
 */

const components = join(__dirname, '../components');
const repoRoot = join(__dirname, '../../../..');

const primitives: Record<string, string[]> = {
  Button: ['Button.tsx'],
  Input: ['Input.tsx', 'Field.ts'],
  Select: ['Select.tsx', 'Dropdown.tsx', 'Dropdown.css'],
  Dialog: ['OriginalDialog.tsx', 'OGDialogTemplate.tsx'],
  Menu: ['DropdownPopup.tsx', 'Dropdown.css'],
  Tabs: ['Tabs.tsx'],
  Switch: ['Switch.tsx'],
  Checkbox: ['Checkbox.tsx'],
  Table: ['Table.tsx'],
  Tooltip: ['Tooltip.tsx', 'Tooltip.css'],
};

const themeDriven = ['Button', 'Input', 'Dialog', 'Tabs', 'Switch', 'Checkbox', 'Table', 'Tooltip'];

/** What the two others still hard-code, and why it stays. */
const remaining: Record<string, string[]> = {
  /** The content's nested-popover layering is a runtime style; the item indicator box and the
   *  list's scroll cap have no role. */
  Select: [
    'Select.tsx: fixed size h-3.5',
    'Select.tsx: fixed size h-96',
    'Select.tsx: fixed size w-3.5',
    'Select.tsx: suppression shadcn/no-inline-styles',
  ],
  /** The menu's z-index comes from the popover stack at runtime. */
  Menu: ['DropdownPopup.tsx: suppression shadcn/no-inline-styles'],
};

const suppressions: Record<string, Record<string, { count: number }>> = JSON.parse(
  readFileSync(join(repoRoot, 'eslint-suppressions.json'), 'utf8'),
);

/** Every Tailwind palette hue, black and white, under any color utility. */
const rawPalette = new RegExp(
  `\\b(?:bg|text|border(?:-[xytblrse])?|ring|outline|fill|stroke|divide|accent|caret|decoration|placeholder|from|via|to|shadow)-(?:${[
    'black',
    'white',
    'slate',
    'gray',
    'zinc',
    'neutral',
    'stone',
    'red',
    'orange',
    'amber',
    'yellow',
    'lime',
    'green',
    'emerald',
    'teal',
    'cyan',
    'sky',
    'blue',
    'indigo',
    'violet',
    'purple',
    'fuchsia',
    'pink',
    'rose',
  ].join('|')})(?:-[0-9]+)?\\b`,
  'g',
);

const isComment = (line: string) => /^\s*(\*|\/\/|\/\*)/.test(line);

/** A stylesheet with every `var(--role, fallback)` reduced to `var(--role)`. */
function withoutVarFallbacks(css: string): string {
  let result = '';
  let index = 0;
  for (let start = css.indexOf('var(', index); start !== -1; start = css.indexOf('var(', index)) {
    let depth = 0;
    let end = start + 3;
    for (; end < css.length; end++) {
      if (css[end] === '(') {
        depth += 1;
      } else if (css[end] === ')') {
        depth -= 1;
      }
      if (depth === 0) {
        break;
      }
    }
    const name = /^var\(\s*(--[\w-]+)/.exec(css.slice(start, end + 1))?.[1] ?? '';
    result += `${css.slice(index, start)}var(${name})`;
    index = end + 1;
  }
  return result + css.slice(index);
}

function hardCoded(file: string): string[] {
  const source = readFileSync(join(components, file), 'utf8');
  const code = source.split('\n').filter((line) => !isComment(line));
  const found = new Set<string>();
  if (file.endsWith('.css')) {
    /** A role's `var()` fallback restates the default for a host without the stock stylesheet;
     *  it is not a value the rule paints while the role is set, so it is set aside first. */
    const rules = withoutVarFallbacks(source.replace(/\/\*[\s\S]*?\*\//g, ''));
    for (const match of rules.matchAll(/(border-radius|box-shadow):\s*[0-9][^;]*/g)) {
      found.add(`${file}: literal ${match[0]}`);
    }
    for (const match of rules.matchAll(
      /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b|rgba?\(\s*[0-9]|hsla?\(/g,
    )) {
      found.add(`${file}: color literal ${match[0]}`);
    }
  } else {
    const text = code.join('\n');
    for (const match of text.matchAll(rawPalette)) {
      found.add(`${file}: raw palette ${match[0]}`);
    }
    for (const match of text.matchAll(
      /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b|rgba?\([0-9]|hsla?\(/g,
    )) {
      found.add(`${file}: color literal ${match[0]}`);
    }
    for (const match of text.matchAll(/\b(?:rounded|shadow)(?:-[a-z]{1,2})?-\[[^\]]*\]/g)) {
      found.add(`${file}: arbitrary ${match[0]}`);
    }
    for (const match of text.matchAll(/\b(?:h|w|size|min-h)-[0-9.]+\b(?!\/)/g)) {
      found.add(`${file}: fixed size ${match[0]}`);
    }
  }
  Object.keys(suppressions[`packages/client/src/components/${file}`] ?? {})
    .filter((rule) => rule.startsWith('shadcn/'))
    .forEach((rule) => found.add(`${file}: suppression ${rule}`));
  return [...found].sort();
}

const values = Object.fromEntries(
  Object.entries(primitives).map(([name, files]) => [name, files.flatMap(hardCoded).sort()]),
);

describe('the ten named primitives', () => {
  it('draws at least eight of them from theme roles alone', () => {
    const driven = Object.keys(primitives).filter((name) => values[name].length === 0);

    expect(driven).toEqual(themeDriven);
    expect(driven.length).toBeGreaterThanOrEqual(8);
  });

  it('reads any raw palette hue under any color utility', () => {
    const hits = (classes: string) => classes.match(rawPalette) ?? [];
    expect(hits('bg-orange-500 text-pink-600 border-emerald-500 fill-white')).toHaveLength(4);
    expect(hits('bg-surface-primary text-text-secondary border-border-light')).toEqual([]);
  });

  it('sets aside a role fallback in a stylesheet but keeps a painted literal', () => {
    expect(
      withoutVarFallbacks(
        '.a { box-shadow: var(--theme-menu-shadow, 0 1px rgb(0 0 0 / 0.1)); color: #fff; }',
      ),
    ).toBe('.a { box-shadow: var(--theme-menu-shadow); color: #fff; }');
  });

  it.each(Object.keys(remaining))('pins what %s still hard-codes', (name) => {
    expect(values[name]).toEqual(remaining[name]);
  });
});

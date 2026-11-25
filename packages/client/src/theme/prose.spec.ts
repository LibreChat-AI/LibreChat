import fs from 'fs';
import path from 'path';
import postcss from 'postcss';

const read = (...segments: string[]): string =>
  fs.readFileSync(path.resolve(__dirname, ...segments), 'utf8');

/**
 * What `@librechat/client/style.css` is built from, in the order the provider imports it: the
 * build writes the sheets out in that order, so this is the order a browser reads the rules in.
 */
const published = Array.from(
  read('context/ThemeProvider.tsx').matchAll(/^import '\.\.\/([\w-]+\.css)';$/gm),
  ([, file]) => read(file),
);
/** The LibreChat app loads its own stylesheet after the library's, as its `main.jsx` imports them. */
const app = read('../../../../client/src/style.css');

/** The classes a message's text carries. */
const MESSAGE = new Set(['markdown', 'prose', 'message-content']);

/**
 * The declaration that wins for `property` on a message's text. Every rule that sets one of these
 * properties on it is a single class selector at the top level, so specificity ties and the last
 * matching rule in source order wins.
 */
function winner(sheets: string[], property: string): string | undefined {
  let value: string | undefined;
  for (const css of sheets) {
    postcss.parse(css).each((node) => {
      if (node.type !== 'rule') {
        return;
      }
      const matches = node.selectors.some(
        (selector) => /^\.[\w-]+$/.test(selector) && MESSAGE.has(selector.slice(1)),
      );
      if (!matches) {
        return;
      }
      node.each((decl) => {
        if (decl.type === 'decl' && decl.prop === property) {
          value = decl.value.replace(/\s+/g, ' ').trim();
        }
      });
    });
  }
  return value;
}

/** Every custom property a sheet sets, on any selector. */
const declared = (css: string): string[] =>
  Array.from(css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:/g), ([, name]) => name);

describe('the custom properties the published stylesheet reads', () => {
  /**
   * What the package gives a value: the theme's stock values, the tokens, and the sheets
   * themselves. `--markdown-font-size` and `--font-size-base` are not among them; the LibreChat
   * app sets those from the reader's settings, and nothing does in another app.
   */
  const defined = new Set(
    [read('defaults.css'), read('tokens.css'), ...published].flatMap(declared),
  );
  /** A property a component writes on the element itself, such as a tool call's expand rows. */
  const components = ['../components', '../../../chat/src/components'].map((directory) =>
    fs
      .readdirSync(path.resolve(__dirname, directory), { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx$/.test(file) && !/\.(spec|test)\./.test(file))
      .map((file) => read(directory, file))
      .join('\n'),
  );
  const inline = (name: string): boolean =>
    components.some((source) => source.includes(`'${name}'`));

  it('falls back from every one the package does not set', () => {
    const bare = published.flatMap((css) =>
      Array.from(
        css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/var\(\s*(--[\w-]+)\s*\)/g),
        ([, name]) => name,
      ),
    );
    expect(bare.length).toBeGreaterThan(0);
    expect([...new Set(bare)].filter((name) => !defined.has(name) && !inline(name))).toEqual([]);
  });

  it('sizes a heading from the message size, or from a length where an app sets none', () => {
    const sized = published.join('\n').match(/^\.markdown h[1-5] \{[^}]*font-size:[^;]*;/gm) ?? [];
    expect(sized).toHaveLength(5);
    for (const rule of sized) {
      expect(rule).toContain('var(--markdown-font-size, var(--font-size-base, 1rem))');
    }
  });
});

describe('how a message’s text is set', () => {
  it('builds the published stylesheet from the typography and the parts', () => {
    expect(published.length).toBeGreaterThan(1);
    expect(published.join('\n')).toMatch(/^\.markdown \{/m);
    expect(published.join('\n')).toMatch(/^\.message-content \{/m);
  });

  it.each([
    ['an app that loads the published stylesheet alone', published],
    ['the LibreChat app, which loads its own after it', [...published, app]],
  ])('reads at the message line height and width in %s', (_host, sheets) => {
    expect(winner(sheets, 'line-height')).toBe('1.6');
    expect(winner(sheets, 'max-width')).toBe('none');
    expect(winner(sheets, 'font-size')).toBe(
      'var(--markdown-font-size, var(--font-size-base, 1rem))',
    );
  });
});

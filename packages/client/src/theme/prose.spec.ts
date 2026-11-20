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

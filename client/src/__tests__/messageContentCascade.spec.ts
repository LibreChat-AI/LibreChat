import fs from 'fs';
import path from 'path';
import postcss from 'postcss';

const read = (...segments: string[]) =>
  fs.readFileSync(path.resolve(__dirname, ...segments), 'utf8');

/** The library stylesheet loads before the app's, as `main.jsx` imports them. */
const sheets = [read('../../../packages/client/src/theme/parts.css'), read('../style.css')];

const ELEMENT_CLASSES = new Set(['markdown', 'prose', 'message-content']);

/**
 * The declaration that wins for `property` on a `.markdown.prose.message-content` element. Every
 * rule here is a single class selector at the top level, so specificity ties and source order
 * decides: the last matching rule wins.
 */
function winner(property: string): string | undefined {
  let value: string | undefined;
  for (const css of sheets) {
    postcss.parse(css).each((node) => {
      if (node.type !== 'rule') {
        return;
      }
      const matches = node.selectors.some(
        (selector) => /^\.[\w-]+$/.test(selector) && ELEMENT_CLASSES.has(selector.slice(1)),
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

describe('message body cascade with the library styles first', () => {
  it('keeps the message typography the app has always drawn', () => {
    expect(winner('line-height')).toBe('1.6');
    expect(winner('font-size')).toBe('var(--markdown-font-size, var(--font-size-base))');
    expect(winner('max-width')).toBe('none');
  });
});

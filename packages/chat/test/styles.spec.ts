import { join, resolve } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * Where the rules behind the package's hand-written classes live. What a component carries has
 * to be styled by a stylesheet that ships: this package's own, or `@librechat/client`'s. A rule
 * the LibreChat app keeps for it in its own stylesheets is applied there and nowhere else.
 */
const ROOT = resolve(__dirname, '../../..');
const read = (path: string): string => readFileSync(path, 'utf8');

/** The class names a stylesheet has rules for, comments aside. */
const classesIn = (css: string): Set<string> =>
  new Set(
    Array.from(
      css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([A-Za-z][\w-]*)/g),
      ([, name]) => name,
    ),
  );

function sourceUnder(directory: string): string {
  let source = '';
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== '__fixtures__') source += sourceUnder(path);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(spec|test)\./.test(entry.name)) {
      source += `${read(path)}\n`;
    }
  }
  return source;
}

const app = new Set([
  ...classesIn(read(join(ROOT, 'client/src/style.css'))),
  ...classesIn(read(join(ROOT, 'client/src/mobile.css'))),
]);
const source = sourceUnder(resolve(__dirname, '../src'));
/** Named in a string a component could put in `className`: whole, between quotes or spaces. */
const named = (name: string): boolean =>
  new RegExp(`['"\` ]${name.replace(/[-]/g, '\\-')}['"\` ]`).test(source);

/**
 * Names the package's source uses that the app's stylesheets still have rules for. Each is a
 * difference an app outside LibreChat would see (the sizes of a code block under
 * `message-content`), or
 * a word that only reads like a class in a string here (`css`, `nav`, `config`). The list may
 * only shrink: moving the rules into a shipped stylesheet takes a name off, and a new name on
 * it means a component leans on the app's stylesheet again.
 */
const APP_STYLED = [
  'active',
  'config',
  'css',
  'dark',
  'gray',
  'group',
  'high-contrast',
  'message-content',
  'nav',
  'tooltip',
  'whitespace-pre-wrap',
];

describe('the stylesheets behind the package’s classes', () => {
  it('leans on the app’s own stylesheets for no class beyond the ones still to move', () => {
    expect([...app].filter(named).sort()).toEqual(APP_STYLED);
  });

  it('ships the rules for the classes only its own components carry', () => {
    for (const name of [
      'message-render',
      'message-timestamp',
      'hover-button',
      'fade-in',
      'scroll-animation-enter-active',
      'katex',
      'composer-slot-resize',
      'composer-effort-thumb',
      'composer-label-in-up',
      'scrollbar-gutter-spacer',
      'azure-bg-color',
      'code-analyze-block',
      'chat-image-sized',
    ]) {
      expect(classesIn(read(require.resolve('@librechat/chat/style.css')))).toContain(name);
      expect(app).not.toContain(name);
    }
  });

  it('is plain CSS that reads no value it does not fall back from', () => {
    const css = read(require.resolve('@librechat/chat/style.css')).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/@apply|@layer|@utility|@import|theme\(/);
    expect(Array.from(css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g), ([, name]) => name)).toEqual([]);
    for (const [, animation] of css.matchAll(/animation:\s*([\w-]+)/g)) {
      expect(css).toMatch(new RegExp(`@keyframes ${animation}\\s*\\{`));
    }
  });

  it('finds a class the app’s components carry too in the client package’s stylesheet', () => {
    expect(named('hide-scrollbar')).toBe(true);
    expect(classesIn(read(require.resolve('@librechat/client/style.css')))).toContain(
      'hide-scrollbar',
    );
    expect(app).not.toContain('hide-scrollbar');
  });

  it('finds the code highlight theme in the client package’s stylesheet, not the app’s', () => {
    const published = classesIn(read(require.resolve('@librechat/client/style.css')));
    for (const name of ['hljs', 'hljs-keyword', 'hljs-string', 'hljs-comment']) {
      expect(published).toContain(name);
      expect(app).not.toContain(name);
    }
  });

  it('leaves the reserved scrollbar gutter to Tailwind’s own utility', () => {
    expect(named('scrollbar-gutter-stable')).toBe(true);
    expect(app).not.toContain('scrollbar-gutter-stable');
  });

  it('finds how written content reads in the client package’s stylesheet, not the app’s', () => {
    const published = read(require.resolve('@librechat/client/style.css'));
    for (const name of ['prose', 'markdown']) {
      expect(classesIn(published)).toContain(name);
      expect(app).not.toContain(name);
    }
    /** Sized from the reader's setting where the app sets one, and from a length where none is. */
    expect(published).toMatch(
      /\.markdown\s*\{[^}]*font-size:\s*var\(--markdown-font-size,\s*var\(--font-size-base,\s*1rem\)\)/,
    );
  });
});

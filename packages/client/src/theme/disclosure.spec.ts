import fs from 'fs';
import path from 'path';

/**
 * A host that loads only `@librechat/client` gets the package styles through its ThemeProvider and
 * nothing from the app's `style.css`. The reasoning, thinking and web search parts open and close
 * their bodies with `.part-expand` and fade the live peek with `.thought-peek`, so those rules, and
 * every other class the parts draw with, have to ship with the package or that host sees a panel
 * that never animates and a peek with hard edges.
 */
const root = path.resolve(__dirname, '../../../..');
const partsDir = path.join(root, 'packages/chat/src/components/parts');
const parts = fs.readFileSync(path.join(__dirname, 'parts.css'), 'utf8');
const appStyles = fs.readFileSync(path.join(root, 'client/src/style.css'), 'utf8');

const stylesheets = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return stylesheets(file);
    }
    return entry.name.endsWith('.css') ? [fs.readFileSync(file, 'utf8')] : [];
  });
const packageStyles = stylesheets(path.join(root, 'packages/client/src')).join('\n');

const defines = (css: string, name: string): boolean =>
  new RegExp(`^\\s*\\.${name}(?![\\w-])`, 'm').test(css);

const sources = ['Reasoning.tsx', 'Thinking.tsx', 'WebSearch.tsx'].map((file) =>
  fs.readFileSync(path.join(partsDir, file), 'utf8'),
);

/** Tailwind's own marker class, and the `role` value that shares its name. */
const TAILWIND = new Set(['group']);

/** Every plain class name in a string literal of the three parts. */
const classNames = Array.from(
  new Set(
    sources
      .flatMap((source) => source.match(/(['"`])(?:(?!\1)[^\\\n])*\1/g) ?? [])
      .flatMap((literal) => literal.slice(1, -1).split(/\s+/))
      .filter((token) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(token) && !TAILWIND.has(token)),
  ),
);

const reducedMotion = parts.split('@media (prefers-reduced-motion: reduce)').slice(1).join('\n');

describe('reasoning, thinking and web search part styles', () => {
  it('finds the classes the parts draw with', () => {
    expect(classNames).toEqual(
      expect.arrayContaining(['part-expand', 'thought-peek', 'tool-status-text']),
    );
  });

  it('draws with no class that only the app stylesheet defines', () => {
    const appOnly = classNames.filter(
      (name) => defines(appStyles, name) && !defines(packageStyles, name),
    );
    expect(appOnly).toEqual([]);
  });

  it.each(['part-expand', 'thought-peek'])('ships .%s with the client package', (name) => {
    expect(defines(parts, name)).toBe(true);
    expect(defines(appStyles, name)).toBe(false);
  });

  it('keeps a transition under reduced motion so a closed body still unmounts', () => {
    expect(reducedMotion).toMatch(/\.part-expand[\s,{]/);
    expect(reducedMotion).toMatch(/grid-template-rows 0\.01ms/);
  });

  it('masks the peek with both the standard and the prefixed property', () => {
    const peek = parts.slice(parts.indexOf('.thought-peek'));
    expect(peek).toMatch(/\bmask-image:/);
    expect(peek).toMatch(/-webkit-mask-image:/);
  });
});

import fs from 'fs';
import path from 'path';

const stylesheet = fs.readFileSync(path.resolve(__dirname, 'parts.css'), 'utf8');

/**
 * A host that loads only `@librechat/client` gets `parts.css` through its ThemeProvider and nothing
 * from the app's `style.css`. Every class the composer palette draws its motion with has to be
 * defined there, together with its reduced-motion override, or that host sees no transition.
 */
const root = path.resolve(__dirname, '../../../..');
const parts = fs.readFileSync(path.join(__dirname, 'parts.css'), 'utf8');
const appStyles = fs.readFileSync(path.join(root, 'client/src/style.css'), 'utf8');
const palette = fs.readFileSync(
  path.join(root, 'packages/chat/src/components/composer/Palette.tsx'),
  'utf8',
);

/** The bodies of every reduced-motion media query, so a rule outside one cannot satisfy a check. */
function reducedMotionBodies(css: string): string {
  const marker = '@media (prefers-reduced-motion: reduce) {';
  const bodies: string[] = [];
  let from = css.indexOf(marker);
  while (from !== -1) {
    let depth = 1;
    let end = from + marker.length;
    while (depth > 0 && end < css.length) {
      if (css[end] === '{') {
        depth += 1;
      } else if (css[end] === '}') {
        depth -= 1;
      }
      end += 1;
    }
    bodies.push(css.slice(from + marker.length, end - 1));
    from = css.indexOf(marker, end);
  }
  return bodies.join('\n');
}

const reducedMotion = reducedMotionBodies(parts);

describe('composer palette styles', () => {
  const classes = Array.from(
    new Set(
      palette.match(/\b(?:animate-composer-[a-z-]+|composer-palette-(?:scroll|rows|instant))\b/g) ??
        [],
    ),
  );

  it('finds the classes the palette draws with', () => {
    expect(classes).toEqual(
      expect.arrayContaining(['animate-composer-popover', 'animate-composer-icon']),
    );
  });

  it.each(classes)('ships .%s with the client package', (name) => {
    expect(parts).toMatch(new RegExp(`^\\.${name}[\\s,{:[]`, 'm'));
  });

  it.each(classes)('leaves .%s out of the app stylesheet', (name) => {
    expect(appStyles).not.toMatch(new RegExp(`^\\s*\\.${name}[\\s,{:[]`, 'm'));
  });

  it.each(['animate-composer-popover', 'animate-composer-icon'])(
    'calms .%s under reduced motion',
    (name) => {
      expect(reducedMotion).toMatch(new RegExp(`\\.${name}[\\s,{:[]`));
    },
  );
});

describe('shared message body typography', () => {
  it('ships the message-content rule with the published styles', () => {
    const rule = stylesheet.match(/^\.message-content \{([^}]*)\}/m);
    expect(rule).not.toBeNull();
    const body = rule?.[1] ?? '';
    expect(body).toMatch(/font-size:\s*var\(--markdown-font-size/);
    expect(body).toMatch(/line-height:\s*1\.6/);
    expect(body).toMatch(/max-width:\s*none/);
  });
});

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

/** The plain top-level rules of the app stylesheet: what can outrank a rule of `parts.css`. */
function plainRules(css: string): string {
  const rules: string[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  let start = 0;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '{') {
      depth += 1;
    } else if (clean[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        const rule = clean.slice(start, i + 1).trim();
        if (!rule.startsWith('@')) {
          rules.push(rule);
        }
        start = i + 1;
      }
    } else if (clean[i] === ';' && depth === 0) {
      start = i + 1;
    }
  }
  return rules.join('\n');
}

/**
 * `main.jsx` loads the client package styles before `style.css`, so a later app rule of equal
 * weight beats `parts.css`. The motion has to come out the way it did when the app defined it.
 */
describe('composer motion in the app cascade', () => {
  let sheet: HTMLStyleElement;

  beforeAll(() => {
    sheet = document.createElement('style');
    sheet.textContent = `${parts}\n${plainRules(appStyles)}`;
    document.head.appendChild(sheet);
  });

  afterAll(() => sheet.remove());

  const render = (className: string, attribute?: string): CSSStyleDeclaration => {
    const element = document.createElement('div');
    element.className = className;
    if (attribute != null) {
      element.setAttribute(attribute, '');
    }
    document.body.appendChild(element);
    const style = getComputedStyle(element);
    element.remove();
    return style;
  };

  it('keeps the popover closed, scaled and on its own curves', () => {
    const style = render('animate-composer-popover');
    expect(style.opacity).toBe('0');
    expect(style.transform).toBe('scale(0.94)');
    expect(style.transition).toContain('opacity 190ms cubic-bezier(0.32, 0.72, 0, 1)');
    expect(style.transition).toContain('transform 260ms cubic-bezier(0.32, 0.72, 0, 1)');
    expect(style.willChange).toBe('transform, opacity');
  });

  it('opens to full size and leaves faster than it enters', () => {
    const entered = render('animate-composer-popover', 'data-enter');
    expect(entered.opacity).toBe('1');
    expect(entered.transform).toBe('scale(1)');
    expect(render('animate-composer-popover', 'data-leave').transitionDuration).toBe(
      '120ms, 140ms',
    );
  });

  it('turns the trigger glyph on the same curve', () => {
    const style = render('animate-composer-icon');
    expect(style.transitionProperty).toBe('transform, rotate');
    expect(style.transitionDuration).toBe('260ms');
    expect(style.transitionTimingFunction).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
  });
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

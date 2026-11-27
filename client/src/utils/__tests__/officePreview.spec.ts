import { withOfficeContrast } from '../officePreview';

/** A trimmed stand-in for what `wrapAsDocument` in `packages/api` emits: a
 *  `:root` palette plus the `prefers-color-scheme` block that used to be the
 *  only thing deciding an Office preview's colours. */
const backendDocument = `<!DOCTYPE html>
<html><head><style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1f2937; --link: #2563eb; }
@media (prefers-color-scheme: dark) { :root { --bg: #1a1a2e; --fg: #e5e7eb; } }
</style></head><body>Preview</body></html>`;

describe('withOfficeContrast', () => {
  /** Both `:root` blocks have the same specificity, so order is the only thing
   *  that decides the winner — the override has to come last, and still inside
   *  the head where the document's own styles live. */
  it('overrides the document palette from inside the head', () => {
    const rendered = withOfficeContrast(backendDocument, true);
    const mediaRule = rendered.indexOf('prefers-color-scheme: dark');
    const override = rendered.lastIndexOf('<style>');

    expect(override).toBeGreaterThan(mediaRule);
    expect(rendered.indexOf('</head>')).toBeGreaterThan(override);
  });

  /** The bug this closes: the preview followed the OS, so an explicit dark
   *  contrast mode still rendered light whenever the OS was light. Pinning
   *  `color-scheme` is what stops the iframe consulting the OS at all. */
  it.each([
    ['dark', true, '#000000', '#ffffff'],
    ['light', false, '#ffffff', '#000000'],
  ] as const)('resolves %s mode against the OS preference', (mode, isDarkMode, canvas, ink) => {
    const rendered = withOfficeContrast(backendDocument, isDarkMode);

    expect(rendered.match(/color-scheme:\s*[^;]+/g)?.at(-1)).toBe(`color-scheme: ${mode}`);
    expect(rendered).toContain(`--bg: ${canvas};`);
    expect(rendered).toContain(`--fg: ${ink};`);
  });

  /** Zebra rows, row hover and the sticky header are three separate cues in the
   *  backend document; collapsing them onto one fill would silently merge them. */
  it('keeps the row, hover and header fills distinct', () => {
    const rendered = withOfficeContrast(backendDocument, false);
    const fills = ['--row-alt', '--row-hover', '--header-bg'].map(
      (name) => rendered.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`))?.[1],
    );

    expect(fills.every(Boolean)).toBe(true);
    expect(new Set(fills).size).toBe(3);
    expect(fills).not.toContain('#ffffff');
  });

  it('still applies to a fragment with no head to close', () => {
    const rendered = withOfficeContrast('<body>Preview</body>', true);

    expect(rendered.startsWith('<style>')).toBe(true);
    expect(rendered).toContain('<body>Preview</body>');
  });

  it('returns empty content unchanged', () => {
    expect(withOfficeContrast('', true)).toBe('');
  });
});

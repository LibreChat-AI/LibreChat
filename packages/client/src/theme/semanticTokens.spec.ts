import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { IThemeRGB } from './types';
import { highContrastDarkTheme, highContrastLightTheme } from './themes/highContrast';
import { createTailwindColors } from './utils/createTailwindColors';
import { defaultTheme } from './themes/default';
import { darkTheme } from './themes/dark';

const sharedComponents = [
  'AnimatedSearchInput.tsx',
  'AlertDialog.tsx',
  'Button.tsx',
  'Chip.tsx',
  'SegmentedMeter.tsx',
  'Dialog.tsx',
  'DialogTemplate.tsx',
  'IconButton.tsx',
  'OGDialogTemplate.tsx',
  'OriginalDialog.tsx',
  'Tag.tsx',
  'Toast.tsx',
];

const sharedDialogComponents = [
  'AlertDialog.tsx',
  'Dialog.tsx',
  'DialogTemplate.tsx',
  'OGDialogTemplate.tsx',
  'OriginalDialog.tsx',
];

describe('shared component color guardrail', () => {
  it('keeps shared primitives free of direct palette utilities and hex colors', () => {
    const directPalette =
      /(?:bg|text|border|ring|from|via|to)-(?:gray|red|green|blue|purple|amber|yellow|orange|pink|indigo|violet|teal|cyan|slate|zinc|neutral|stone)-\d/;
    /** Only CSS-legal hex lengths (3, 4, 6, 8). `{3,8}` also matched a five-
     *  digit issue reference in a comment — see the PR number in
     *  `OriginalDialog.tsx` — which reads as a color to a regex and to nobody
     *  else. */
    const hexColor = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/i;

    sharedComponents.forEach((component) => {
      const source = readFileSync(join(__dirname, '..', 'components', component), 'utf8');

      expect(source).not.toMatch(directPalette);
      expect(source).not.toMatch(hexColor);
    });

    /** The guardrail still has to catch what it exists for. */
    expect('bg-surface-primary text-[#ff0000]').toMatch(hexColor);
    expect('color: #fff;').toMatch(hexColor);
    expect('#aabbccdd').toMatch(hexColor);
    /** …and leave prose alone: an issue reference is not a color. */
    expect('pinned by #11023').not.toMatch(hexColor);
    expect('closes #15738').not.toMatch(hexColor);
  });

  it('keeps every shared dialog shell on the semantic dialog surface', () => {
    sharedDialogComponents.forEach((component) => {
      const source = readFileSync(join(__dirname, '..', 'components', component), 'utf8');

      expect(source).toMatch(/\bbg-surface-dialog\b/);
    });
  });
});

describe('dark dialog surface', () => {
  it('matches the legacy rendered background in CSS and the runtime theme', () => {
    const appStyles = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'client', 'src', 'style.css'),
      'utf8',
    );

    expect(appStyles).toMatch(/--gray-875:\s*18 18 18;/);
    expect(appStyles).toMatch(/--surface-dialog:\s*var\(--gray-875\);/);
    expect(darkTheme['rgb-surface-dialog']).toBe('18 18 18');
  });
});

describe('dark hover surface', () => {
  it('uses the gray-650 midpoint in both CSS and the runtime theme', () => {
    const appStyles = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'client', 'src', 'style.css'),
      'utf8',
    );

    expect(appStyles).toMatch(/--gray-650:\s*57 57 57;/);
    expect(appStyles).toMatch(/--surface-hover:\s*var\(--gray-650\);/);
    expect(darkTheme['rgb-surface-hover']).toBe('57 57 57');
  });
});

describe('composer hover surface', () => {
  it('keeps light hover unchanged and uses the lighter dark hover surface', () => {
    const appStyles = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'client', 'src', 'style.css'),
      'utf8',
    );

    expect(appStyles).toMatch(/--surface-composer-hover:\s*var\(--gray-200\);/);
    expect(appStyles).toMatch(/--surface-composer-hover:\s*var\(--gray-600\);/);
    expect(defaultTheme['rgb-surface-composer-hover']).toBe('227 227 227');
    expect(darkTheme['rgb-surface-composer-hover']).toBe('66 66 66');
  });
});

describe('dark destructive text', () => {
  it('uses red-400 without changing the status error token', () => {
    const appStyles = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'client', 'src', 'style.css'),
      'utf8',
    );

    expect(appStyles).toMatch(/--text-destructive:\s*var\(--red-400\);/);
    expect(darkTheme['rgb-text-destructive']).toBe('248 113 113');
    expect(darkTheme['rgb-status-error']).toBe('252 165 165');
  });
});

describe('light brand text', () => {
  it('uses the contrasting purple foreground in the default theme', () => {
    expect(defaultTheme['rgb-brand-purple']).toBe('126 34 206');
  });
});

describe('shared field and dropdown interaction styles', () => {
  it('keeps pointer focus stable and keyboard focus visible on text fields', () => {
    /** The focus treatment lives in the shared field module, so guard it there and
     *  assert the primitives still compose it rather than restating the classes. */
    const field = readFileSync(join(__dirname, '..', 'components', 'Field.ts'), 'utf8');

    expect(field).toMatch(/focus-visible:border-border-medium/);
    expect(field).toMatch(/focus-visible:ring-2/);
    expect(field).toMatch(/focus-visible:ring-text-primary/);

    const composers: Array<[string, RegExp]> = [
      ['Input.tsx', /\bfieldControl\b/],
      ['Textarea.tsx', /\bfieldBase\b/],
      ['Dropdown.tsx', /\bfieldControl\b/],
      ['ControlCombobox.tsx', /\bfieldControl\b/],
    ];
    composers.forEach(([component, token]) => {
      const source = readFileSync(join(__dirname, '..', 'components', component), 'utf8');
      expect(source).toMatch(token);
    });

    const secretInput = readFileSync(
      join(__dirname, '..', 'components', 'SecretInput.tsx'),
      'utf8',
    );
    expect(secretInput).not.toMatch(/(?:hover|focus-visible):border-/);

    const appStyles = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'client', 'src', 'style.css'),
      'utf8',
    );
    expect(appStyles).toMatch(/html\[data-input-modality='pointer'\]/);
    expect(appStyles).toMatch(/html\[data-input-modality='keyboard'\]/);
    expect(appStyles).toMatch(/outline:\s*2px solid rgb\(var\(--text-primary\)\) !important;/);
    expect(appStyles).not.toMatch(/textarea\s*\n\):hover,/);
  });

  it('keeps shared dropdown triggers transparent at rest and while disabled', () => {
    const source = readFileSync(join(__dirname, '..', 'components', 'Dropdown.tsx'), 'utf8');

    expect(source).toMatch(/\bbg-transparent\b/);
    expect(source).toMatch(/\bdisabled:hover:bg-transparent\b/);
    expect(source).not.toMatch(/\bbg-surface-primary\b/);
  });
});

type Rgb = [number, number, number];

/** Surfaces that carry body copy; `surface-tertiary` is chip/input fill, added per-group below. */
const canvasSurfaces: Array<keyof IThemeRGB> = [
  'rgb-surface-primary',
  'rgb-surface-primary-alt',
  'rgb-surface-secondary',
  'rgb-surface-dialog',
  'rgb-surface-chat',
  'rgb-surface-code',
  'rgb-presentation',
];

const neutralTextTokens: Array<keyof IThemeRGB> = [
  'rgb-text-primary',
  'rgb-text-secondary',
  'rgb-text-secondary-alt',
  'rgb-text-tertiary',
];

const statusTextTokens: Array<keyof IThemeRGB> = ['rgb-text-warning', 'rgb-text-destructive'];

/** How Alert/Badge/Tag/Chip paint every status variant: `text-status-x` on `bg-status-x-subtle`. */
const statusHues = ['success', 'info', 'warning', 'error', 'neutral'] as const;

const WCAG_AA_NORMAL = 4.5;

function toRgb(theme: IThemeRGB, token: keyof IThemeRGB): Rgb {
  const parts = theme[token]?.trim().split(/\s+/).map(Number);
  if (parts?.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`theme token "${token}" is not an "R G B" triplet`);
  }
  return [parts[0], parts[1], parts[2]];
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function belowAA(
  theme: IThemeRGB,
  textTokens: Array<keyof IThemeRGB>,
  surfaces: Array<keyof IThemeRGB>,
): string[] {
  return textTokens.flatMap((text) =>
    surfaces.flatMap((surface) => {
      const ratio = contrast(toRgb(theme, text), toRgb(theme, surface));
      return ratio < WCAG_AA_NORMAL ? [`${text} on ${surface}: ${ratio.toFixed(2)}:1`] : [];
    }),
  );
}

describe.each([
  ['default', defaultTheme],
  ['dark', darkTheme],
  ['high contrast light', highContrastLightTheme],
  ['high contrast dark', highContrastDarkTheme],
])('%s theme text contrast', (_name, theme: IThemeRGB) => {
  it('keeps neutral text at WCAG AA on every surface it renders on', () => {
    expect(belowAA(theme, neutralTextTokens, [...canvasSurfaces, 'rgb-surface-tertiary'])).toEqual(
      [],
    );
  });

  it('keeps warning and destructive text at WCAG AA on canvas surfaces', () => {
    expect(belowAA(theme, statusTextTokens, canvasSurfaces)).toEqual([]);
  });

  it('keeps every status hue at WCAG AA against its own subtle fill', () => {
    const failures = statusHues.flatMap((hue) =>
      belowAA(
        theme,
        [`rgb-status-${hue}` as keyof IThemeRGB],
        [`rgb-status-${hue}-subtle` as keyof IThemeRGB],
      ),
    );
    expect(failures).toEqual([]);
  });
});

/** The meter paints segments on `surface-tertiary`; the swatch and popover chrome
 *  sit on `surface-secondary`; prompt categories sit on `surface-primary`;
 *  checked capability badges sit on `surface-chat`; dialog option toggles sit
 *  on `surface-dialog`. All have to clear the 3:1 mark-contrast floor. */
const seriesTokens = Array.from(
  { length: 8 },
  (_, index) => `rgb-series-${index + 1}` as keyof IThemeRGB,
);
const seriesSurfaces: Array<keyof IThemeRGB> = [
  'rgb-surface-primary',
  'rgb-surface-tertiary',
  'rgb-surface-secondary',
  'rgb-surface-chat',
  'rgb-surface-dialog',
];
const WCAG_MARK_MIN = 3;

describe('categorical series scale', () => {
  it('defines every slot in both modes as an "R G B" triplet', () => {
    seriesTokens.forEach((token) => {
      expect(() => toRgb(defaultTheme, token)).not.toThrow();
      expect(() => toRgb(darkTheme, token)).not.toThrow();
    });
  });

  it('never reuses a reserved status colour for series identity', () => {
    const reserved = new Set(
      statusHues.flatMap((hue) => [
        defaultTheme[`rgb-status-${hue}` as keyof IThemeRGB],
        darkTheme[`rgb-status-${hue}` as keyof IThemeRGB],
      ]),
    );

    seriesTokens.forEach((token) => {
      expect(reserved.has(defaultTheme[token])).toBe(false);
      expect(reserved.has(darkTheme[token])).toBe(false);
    });
  });

  it('keeps the app CSS defaults in step with the runtime themes', () => {
    const appStyles = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'client', 'src', 'style.css'),
      'utf8',
    );

    seriesTokens.forEach((token) => {
      const property = token.slice(4);
      const declared = [...appStyles.matchAll(new RegExp(`--${property}:\\s*([^;]+);`, 'g'))].map(
        (match) => match[1].trim(),
      );

      /** One declaration for `html`, one for `.dark` — and both must match. */
      expect(declared).toEqual([defaultTheme[token], darkTheme[token]]);
    });
  });

  it('exposes each slot as a Tailwind utility backed by its CSS variable', () => {
    const colors = createTailwindColors();

    seriesTokens.forEach((token) => {
      const property = token.slice(4);
      expect(colors[property]).toBe(`rgb(var(--${property}) / <alpha-value>)`);
    });
  });
});

describe.each([
  ['default', defaultTheme],
  ['dark', darkTheme],
  ['high contrast light', highContrastLightTheme],
  ['high contrast dark', highContrastDarkTheme],
])('%s series contrast', (_name, theme: IThemeRGB) => {
  it('keeps every series slot at the 3:1 mark floor on its consumer surfaces', () => {
    const failures = seriesTokens.flatMap((token) =>
      seriesSurfaces.flatMap((surface) => {
        const ratio = contrast(toRgb(theme, token), toRgb(theme, surface));
        return ratio < WCAG_MARK_MIN ? [`${token} on ${surface}: ${ratio.toFixed(2)}:1`] : [];
      }),
    );

    expect(failures).toEqual([]);
  });

  /** A series slot is not only a chart mark: the file-source badges fill a chip
   *  with one and drop a glyph on top, so a slot has to carry `text-on-status`
   *  at the same 3:1 floor. */
  it('lets every series slot carry the status label at the 3:1 mark floor', () => {
    const failures = seriesTokens.flatMap((token) => {
      const ratio = contrast(toRgb(theme, token), toRgb(theme, 'rgb-text-on-status'));
      return ratio < WCAG_MARK_MIN ? [`${token} under text-on-status: ${ratio.toFixed(2)}:1`] : [];
    });

    expect(failures).toEqual([]);
  });
});

describe.each([
  ['default', defaultTheme],
  ['dark', darkTheme],
  ['high contrast light', highContrastLightTheme],
  ['high contrast dark', highContrastDarkTheme],
])('%s skill indicators', (_name, theme: IThemeRGB) => {
  it('keeps informational marks at the 3:1 floor on every skill surface', () => {
    const indicator = toRgb(theme, 'rgb-status-info');
    const surfaces: Array<keyof IThemeRGB> = [
      'rgb-presentation',
      'rgb-surface-secondary',
      'rgb-surface-active',
    ];

    const failures = surfaces.flatMap((surface) => {
      const ratio = contrast(indicator, toRgb(theme, surface));
      return ratio < WCAG_MARK_MIN ? [`${surface}: ${ratio.toFixed(2)}:1`] : [];
    });

    expect(failures).toEqual([]);
  });
});

/** `status-success-strong` is the one status fill that also paints bare marks:
 *  the selected-tool check, the version timeline rail and its "current" dot, and
 *  the selected prompt-version chip. It owes two ratios at once, AA under the
 *  `text-on-status` label it carries and the 3:1 mark floor against the panel it
 *  sits on. `surface-secondary` is that panel in every mode. */
describe.each([
  ['default', defaultTheme],
  ['dark', darkTheme],
  ['high contrast light', highContrastLightTheme],
  ['high contrast dark', highContrastDarkTheme],
])('%s success fill', (_name, theme: IThemeRGB) => {
  it('carries its label at WCAG AA', () => {
    const ratio = contrast(
      toRgb(theme, 'rgb-status-success-strong'),
      toRgb(theme, 'rgb-text-on-status'),
    );
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });

  it('keeps its silhouette at the 3:1 mark floor on the panel', () => {
    const ratio = contrast(
      toRgb(theme, 'rgb-status-success-strong'),
      toRgb(theme, 'rgb-surface-secondary'),
    );
    expect(ratio).toBeGreaterThanOrEqual(WCAG_MARK_MIN);
  });
});

describe('success fill defaults', () => {
  /** Both copies have to move together: the value is a tuned hex rather than a
   *  palette step, so the stylesheet cannot alias it to a `--green-*` step. */
  it('keeps the app CSS in step with the runtime themes', () => {
    const appStyles = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'client', 'src', 'style.css'),
      'utf8',
    );

    const declared = [...appStyles.matchAll(/--status-success-strong:\s*([^;]+);/g)].map((match) =>
      match[1].trim(),
    );

    /** One declaration for `html`, one for `.dark`, and both must match. */
    expect(declared).toEqual([
      defaultTheme['rgb-status-success-strong'],
      darkTheme['rgb-status-success-strong'],
    ]);
  });
});

/** `status-verified` paints one thing: the check a first-party item wears next
 *  to its name. Both of its relationships are graphical objects under WCAG
 *  1.4.11, so both owe 3:1 and neither owes AA: the badge against the card it
 *  sits on, and the `text-on-status` check against the badge. That is where it
 *  parts from the success fill above, which carries a text label and therefore
 *  owes AA. The card is not one surface — `ToolCard` rests on the dialog and
 *  repaints to `surface-tertiary` on hover — so the silhouette is checked
 *  against every background the card can take. Separate from
 *  `status-success-strong` on purpose: green already means selected on the same
 *  card, so provenance needs its own hue. */
describe.each([
  ['default', defaultTheme],
  ['dark', darkTheme],
  ['high contrast light', highContrastLightTheme],
  ['high contrast dark', highContrastDarkTheme],
])('%s verified fill', (_name, theme: IThemeRGB) => {
  it('carries its check at the 3:1 mark floor', () => {
    const ratio = contrast(toRgb(theme, 'rgb-status-verified'), toRgb(theme, 'rgb-text-on-status'));
    expect(ratio).toBeGreaterThanOrEqual(WCAG_MARK_MIN);
  });

  it('keeps its silhouette at the 3:1 mark floor on every card state', () => {
    const mark = toRgb(theme, 'rgb-status-verified');
    /** Resting card, the panel behind the grid, and the hover repaint from
     *  `ToolCard`'s `hover:bg-surface-tertiary`. */
    const surfaces: Array<keyof IThemeRGB> = [
      'rgb-surface-dialog',
      'rgb-surface-secondary',
      'rgb-surface-tertiary',
    ];

    const failures = surfaces.flatMap((surface) => {
      const ratio = contrast(mark, toRgb(theme, surface));
      return ratio < WCAG_MARK_MIN ? [`${surface}: ${ratio.toFixed(2)}:1`] : [];
    });

    expect(failures).toEqual([]);
  });
});

describe('verified fill defaults', () => {
  /** Tuned values rather than palette steps in either mode, so the stylesheet
   *  cannot alias them to a `--blue-*` step and both copies move together. */
  it('keeps the app CSS in step with the runtime themes', () => {
    const appStyles = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'client', 'src', 'style.css'),
      'utf8',
    );

    const declared = [...appStyles.matchAll(/--status-verified:\s*([^;]+);/g)].map((match) =>
      match[1].trim(),
    );

    expect(declared).toEqual([
      defaultTheme['rgb-status-verified'],
      darkTheme['rgb-status-verified'],
    ]);
  });
});

/** The shared `Switch` paints this track, so it travels with the package rather
 *  than the app stylesheet. It is a UI component boundary under WCAG 1.4.11 and
 *  has to stay distinct from the `surface-primary` thumb on it and from the
 *  `surface-inverted` fill it swaps with when checked. */
describe.each([
  ['default', defaultTheme],
  ['dark', darkTheme],
  ['high contrast light', highContrastLightTheme],
  ['high contrast dark', highContrastDarkTheme],
])('%s switch track', (_name, theme: IThemeRGB) => {
  it('keeps the unchecked track at the 3:1 mark floor against thumb and checked fill', () => {
    const track = toRgb(theme, 'rgb-switch-unchecked');
    (['rgb-surface-primary', 'rgb-surface-inverted'] as Array<keyof IThemeRGB>).forEach(
      (surface) => {
        expect({ surface, ok: contrast(track, toRgb(theme, surface)) >= WCAG_MARK_MIN }).toEqual({
          surface,
          ok: true,
        });
      },
    );
  });
});

describe('switch track defaults', () => {
  /** The app stylesheet only restates the registry now: the contrast modes used
   *  to carry their own `html.high-contrast` overrides here, which the published
   *  package never shipped. */
  it('keeps the app CSS in step with the runtime themes', () => {
    const appStyles = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'client', 'src', 'style.css'),
      'utf8',
    );

    const declared = [...appStyles.matchAll(/--switch-unchecked:\s*([^;]+);/g)].map((match) =>
      match[1].trim(),
    );

    expect(declared).toEqual([
      defaultTheme['rgb-switch-unchecked'],
      darkTheme['rgb-switch-unchecked'],
    ]);
  });
});

/** The syntax palette used to live as raw hex in `style.css`, which meant a
 *  change had to be made twice and neither copy was checked. It is a registry
 *  token map now, so the stylesheet is only allowed to restate it. */
describe('syntax highlighting palette', () => {
  const syntaxTokens = (
    ['comment', 'meta', 'builtin', 'keyword', 'string', 'attr', 'title'] as const
  ).map((role) => `rgb-syntax-${role}` as keyof IThemeRGB);

  it('is declared in both bundled themes', () => {
    syntaxTokens.forEach((token) => {
      expect(() => toRgb(defaultTheme, token)).not.toThrow();
      expect(() => toRgb(darkTheme, token)).not.toThrow();
    });
  });

  it('keeps the app CSS defaults in step with the runtime themes', () => {
    const appStyles = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'client', 'src', 'style.css'),
      'utf8',
    );

    syntaxTokens.forEach((token) => {
      const property = token.slice(4);
      const declared = [...appStyles.matchAll(new RegExp(`--${property}:\\s*([^;]+);`, 'g'))].map(
        (match) => match[1].trim(),
      );

      /** `html` may alias a raw palette entry; `.dark` states the triplet. */
      expect(declared).toHaveLength(2);
      expect(declared[1]).toBe(darkTheme[token]);
    });
  });

  it('leaves no hard-coded syntax hex behind in the stylesheet', () => {
    const appStyles = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'client', 'src', 'style.css'),
      'utf8',
    );
    const hljsRules = [...appStyles.matchAll(/^\.hljs[^{]*\{([^}]*)\}/gm)].map((match) => match[1]);

    expect(hljsRules.length).toBeGreaterThan(0);
    expect(hljsRules.filter((body) => /#[0-9a-f]{3,8}|hsla?\(/i.test(body))).toEqual([]);
  });
});

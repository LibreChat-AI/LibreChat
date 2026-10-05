import '@testing-library/jest-dom';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import type { ThemeDefinition } from '../theme/types';
import type { MeterSegment } from './SegmentedMeter';
import { resolveTheme, validateThemeDefinition, THEME_VERSION } from '../theme/registry';
import { applyResolvedTheme, clearAppliedTheme } from '../theme/utils/applyTheme';
import { SegmentedMeter, MeterSwatch, SERIES_SLOT_COUNT } from './SegmentedMeter';

const segments: MeterSegment[] = [
  { id: 'a', value: 500, slot: 1, outlined: true },
  { id: 'b', value: 250, slot: 2 },
  { id: 'c', value: 10, slot: 2, hatched: true },
];

const renderMeter = (props: Partial<React.ComponentProps<typeof SegmentedMeter>> = {}) =>
  render(<SegmentedMeter segments={segments} max={1000} data-testid="meter" {...props} />);

const children = () => Array.from(screen.getByTestId('meter').children) as HTMLElement[];

/** The CSS serializer folds `0.5 * 100%` down to `50%`, so read the parts back
 *  out of the declaration rather than matching the authored string. */
const sizing = (el: HTMLElement): { fraction: number; gapShare: number } => {
  const width = el.style.width;
  const fraction = Number(/([\d.]+)%/.exec(width)?.[1]) / 100;
  const gapShare = Number(/-\s*([\d.]+)rem/.exec(width)?.[1] ?? 0);
  return { fraction, gapShare };
};

describe('SegmentedMeter', () => {
  it('sizes each segment against max and leaves the shortfall as bare track', () => {
    renderMeter();

    expect(children().map((child) => sizing(child).fraction)).toEqual([0.5, 0.25, 0.01]);
    expect(screen.getByTestId('meter')).toHaveClass('bg-surface-tertiary');
  });

  it('takes the gaps out of the fill, not out of the free track', () => {
    renderMeter();

    /** Three segments touch across two 0.125rem gaps. Each gives up its share of
     *  that 0.25rem, so fills + gaps span exactly the 76% that is actually used:
     *  a bar reading three-quarters full means three-quarters of the window is gone. */
    const parts = children().map(sizing);
    const filled = parts.reduce((sum, part) => sum + part.fraction, 0);
    const surrendered = parts.reduce((sum, part) => sum + part.gapShare, 0);

    /** Shares are rounded to 3dp on the way into the declaration. */
    expect(filled).toBeCloseTo(0.76, 5);
    expect(surrendered).toBeCloseTo(0.25, 2);
    parts.forEach((part) => expect(part.gapShare).toBeCloseTo((0.25 * part.fraction) / filled, 2));
  });

  it('reserves no gap share for a lone segment', () => {
    renderMeter({ segments: [{ id: 'only', value: 500, slot: 1 }] });

    expect(sizing(children()[0])).toEqual({ fraction: 0.5, gapShare: 0 });
  });

  it('floors every rendered segment so a present category cannot vanish', () => {
    renderMeter({ segments: [{ id: 'tiny', value: 1, slot: 3 }], max: 1_000_000 });

    expect(children()[0].style.minWidth).toBe('0.125rem');
  });

  it('drops segments that contribute nothing', () => {
    renderMeter({
      segments: [
        { id: 'a', value: 0, slot: 1 },
        { id: 'b', value: -5, slot: 2 },
        { id: 'c', value: 5, slot: 3 },
      ],
    });

    expect(children()).toHaveLength(1);
    expect(children()[0]).toHaveClass('bg-series-3');
  });

  it('never lets a segment exceed the full track', () => {
    renderMeter({ segments: [{ id: 'over', value: 5000, slot: 1 }], max: 1000 });

    expect(sizing(children()[0])).toEqual({ fraction: 1, gapShare: 0 });
  });

  it('renders the outlined variant as a tint plus a solid edge', () => {
    renderMeter();

    expect(children()[0]).toHaveClass('bg-series-1/25');
    expect(children()[0]).toHaveClass('ring-1', 'ring-inset', 'ring-series-1');
    expect(children()[1]).toHaveClass('bg-series-2');
    expect(children()[1].className).not.toContain('ring-series');
  });

  it('recedes every segment but the highlighted one', () => {
    renderMeter({ highlightId: 'a' });

    expect(children()[0].className).not.toContain('opacity-40');
    children()
      .slice(1)
      .forEach((child) => expect(child).toHaveClass('opacity-40'));
  });

  it('recedes all segments when none matches the highlight', () => {
    renderMeter({ highlightId: 'nonexistent' });

    children().forEach((child) => expect(child).toHaveClass('opacity-40'));
  });

  it('hatches without changing the slot, and reads the stripe from the theme', () => {
    renderMeter();

    const [, solid, hatched] = children();

    expect(hatched).toHaveClass('bg-series-2');
    expect(solid.style.backgroundImage).toBe('');
    expect(hatched.style.backgroundImage).toContain('repeating-linear-gradient');
    expect(hatched.style.backgroundImage).toContain('var(--surface-tertiary)');
    /** A literal colour here would not follow a theme swap. */
    expect(hatched.style.backgroundImage).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it('wraps slots past the end of the scale instead of rendering untinted', () => {
    renderMeter({
      segments: [
        { id: 'wrap', value: 1, slot: SERIES_SLOT_COUNT + 1 },
        { id: 'zero', value: 1, slot: 0 },
      ],
    });

    expect(children()[0]).toHaveClass('bg-series-1');
    expect(children()[1]).toHaveClass(`bg-series-${SERIES_SLOT_COUNT}`);
  });

  it('leaves the accessible description to the caller', () => {
    renderMeter({ role: 'progressbar', 'aria-valuenow': 75, 'aria-label': 'Context usage' });

    const meter = screen.getByRole('progressbar', { name: 'Context usage' });

    expect(meter).toHaveAttribute('aria-valuenow', '75');
    children().forEach((child) => expect(child).toHaveAttribute('aria-hidden', 'true'));
  });
});

describe('MeterSwatch', () => {
  it('paints the same treatment as the segment it keys', () => {
    render(
      <>
        <MeterSwatch segment={{ slot: 1, outlined: true }} data-testid="outlined" />
        <MeterSwatch segment={{ slot: 2, hatched: true }} data-testid="hatched" />
        <MeterSwatch segment={{ slot: 3 }} data-testid="plain" />
      </>,
    );

    expect(screen.getByTestId('outlined')).toHaveClass('bg-series-1/25', 'ring-series-1');
    expect(screen.getByTestId('hatched')).toHaveClass('bg-series-2');
    expect(screen.getByTestId('hatched').style.backgroundImage).toContain(
      'var(--surface-tertiary)',
    );
    expect(screen.getByTestId('plain')).toHaveClass('bg-series-3');
    expect(screen.getByTestId('plain').style.backgroundImage).toBe('');
  });
});

/** AGENTS.md requires a deliberately different reference theme, to prove the
 *  component follows theme data rather than the bundled LibreChat values. */
const referenceTheme: ThemeDefinition = {
  version: THEME_VERSION,
  name: 'reference',
  modes: {
    light: {
      colors: {
        'rgb-series-1': '12 34 56',
        'rgb-series-2': '210 5 90',
        'rgb-series-3': '7 199 111',
        'rgb-series-4': '250 250 10',
        'rgb-series-5': '99 0 200',
        'rgb-series-6': '1 2 3',
        'rgb-series-7': '240 120 0',
        'rgb-surface-tertiary': '30 30 30',
      },
    },
  },
};

describe('reference theme', () => {
  afterEach(() => {
    clearAppliedTheme();
  });

  it('is accepted by the registry, so a theme author can retint the scale', () => {
    expect(validateThemeDefinition(referenceTheme)).toEqual([]);
  });

  it('carries the reference values through to the applied CSS variables', () => {
    applyResolvedTheme(resolveTheme(referenceTheme, 'light'));

    const root = document.documentElement;

    expect(root.style.getPropertyValue('--series-1')).toBe('12 34 56');
    expect(root.style.getPropertyValue('--series-7')).toBe('240 120 0');
    expect(root.style.getPropertyValue('--surface-tertiary')).toBe('30 30 30');
  });

  it('paints every mark from those variables, with no value of its own', () => {
    applyResolvedTheme(resolveTheme(referenceTheme, 'light'));
    const { container } = render(
      <>
        <SegmentedMeter segments={segments} max={1000} data-testid="meter" />
        <MeterSwatch segment={{ slot: 3 }} data-testid="swatch" />
      </>,
    );

    /** Nothing in the rendered tree may carry a colour the theme cannot reach:
     *  no literal colours, and every hatch stripe read from a theme variable. */
    const markup = container.innerHTML;
    expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(markup).not.toMatch(/\brgba?\((?!var\()/);

    const tokens = readFileSync(join(__dirname, '../theme/tokens.css'), 'utf8');
    const meter = screen.getByTestId('meter');
    const slotOf = (el: Element) => /\bbg-series-(\d)\b/.exec(el.className)?.[1];

    [...meter.children, screen.getByTestId('swatch')].forEach((el) => {
      const slot = slotOf(el) ?? /\bbg-series-(\d)\/25\b/.exec(el.className)?.[1];
      expect(slot).toBeDefined();
      /** The utility the mark wears resolves to the variable the theme just set. */
      expect(tokens).toContain(`--color-series-${slot}: rgb(var(--series-${slot}));`);
    });
  });
});

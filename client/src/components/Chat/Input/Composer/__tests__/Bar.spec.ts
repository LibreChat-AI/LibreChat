import type { PaletteEntry } from '~/hooks/Input/usePaletteEntries';
import { chipMenuModes, chipsFitInline, formatElapsed, projectBarEntries } from '../Bar';

/** Pure decisions behind the bar's tool projection, layout and elapsed time. */

const chip = (key: string) => ({ key });
const entry = (key: string, overrides: Partial<PaletteEntry> = {}): PaletteEntry => ({
  key,
  itemType: 'builtin',
  itemId: key,
  label: key,
  icon: null,
  section: 'tool',
  active: false,
  pinned: false,
  onSelect: jest.fn(),
  ...overrides,
});

describe('projectBarEntries', () => {
  it('keeps active and pinned tools but excludes staged skills', () => {
    const active = entry('active', { active: true });
    const pinned = entry('pinned', { pinned: true });
    const inactive = entry('inactive');
    const skill = entry('skill', { section: 'skill', active: true, pinned: true });

    expect(projectBarEntries([active, pinned, inactive, skill])).toEqual([active, pinned]);
  });

  it('keeps a pinned MCP menu alongside selected server chips', () => {
    const github = entry('mcp:github', {
      itemType: 'mcp',
      itemId: 'github',
      section: 'mcp',
    });
    const pinnedMcp = entry('mcp:pinned', {
      itemType: 'mcp',
      itemId: 'mcp',
      section: 'mcp',
      active: true,
      pinned: true,
    });

    const projected = projectBarEntries([github], pinnedMcp);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toEqual(
      expect.objectContaining({
        key: 'mcp:pinned',
        modes: [expect.objectContaining({ id: 'github', label: 'mcp:github', active: false })],
      }),
    );

    const selected = { ...github, active: true };
    const selectedProjection = projectBarEntries([selected], pinnedMcp);
    expect(selectedProjection).toHaveLength(2);
    expect(selectedProjection[0]).toBe(selected);
    expect(selectedProjection[1]).toEqual(
      expect.objectContaining({
        key: 'mcp:pinned',
        modes: [expect.objectContaining({ id: 'github', active: true })],
      }),
    );
  });
});

describe('chipMenuModes', () => {
  it('keeps named sub-modes and drops icon-only actions', () => {
    expect(
      chipMenuModes([
        { id: 'configure', label: 'Configure', active: false, icon: 'gear', onSelect: jest.fn() },
        { id: 'default', label: 'Default', active: true, onSelect: jest.fn() },
      ]),
    ).toEqual([expect.objectContaining({ id: 'default' })]);
  });

  it('returns nothing when every mode is an icon action', () => {
    expect(
      chipMenuModes([
        { id: 'configure', label: 'Configure', active: false, icon: 'gear', onSelect: jest.fn() },
      ]),
    ).toEqual([]);
  });
});

describe('chipsFitInline', () => {
  const widths = { a: 40, b: 60, c: 100 };

  it('keeps an empty row inline, whatever the room', () => {
    expect(chipsFitInline([], widths, 0)).toBe(true);
    expect(chipsFitInline([], widths, 500)).toBe(true);
  });

  it('gives chips a row of their own once there is no room at all', () => {
    expect(chipsFitInline([chip('a')], widths, 0)).toBe(false);
    expect(chipsFitInline([chip('a')], widths, -10)).toBe(false);
  });

  /* On the first pass nothing has been measured, and guessing would move the
     chips twice: once on the guess and again on the measurement. */
  it('keeps everything inline until anything has been measured', () => {
    expect(chipsFitInline([chip('a'), chip('b')], {}, 10)).toBe(true);
  });

  /* Once the measured ones already overflow, the answer is known without the
     rest: the row cannot hold them whatever the unmeasured chip turns out to be. */
  it('wraps as soon as the measured chips alone do not fit', () => {
    expect(chipsFitInline([chip('c'), chip('unmeasured')], widths, 50)).toBe(false);
  });

  it('counts the gap between chips, not just the chips', () => {
    /* 40 + 60 alone would fit exactly; the gap between them is what does not. */
    expect(chipsFitInline([chip('a'), chip('b')], widths, 100)).toBe(false);
    expect(chipsFitInline([chip('a'), chip('b')], widths, 108)).toBe(true);
  });

  it('takes a row that fills the space exactly', () => {
    expect(chipsFitInline([chip('c')], widths, 100)).toBe(true);
    expect(chipsFitInline([chip('c')], widths, 99)).toBe(false);
  });
});

describe('formatElapsed', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [59, '0:59'],
    [60, '1:00'],
    [61, '1:01'],
    [600, '10:00'],
    [3599, '59:59'],
  ])('reads %i seconds as %s', (seconds, expected) => {
    expect(formatElapsed(seconds)).toBe(expected);
  });
});

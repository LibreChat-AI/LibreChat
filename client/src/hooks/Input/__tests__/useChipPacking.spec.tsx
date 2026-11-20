import React from 'react';
import { render, act } from '@testing-library/react';
import useChipPacking from '../useChipPacking';

/**
 * The chips are reordered from their measured widths, so the interesting cases
 * are the ones before a measurement exists and the ones after it goes stale.
 */

/** jsdom lays nothing out, so each chip reports the width it was given. */
const widthByLabel: Record<string, number> = {};
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get(this: HTMLElement) {
    return widthByLabel[this.textContent ?? ''] ?? 0;
  },
});

interface Chip {
  key: string;
}

let seen: string[] = [];
let measured: Record<string, number> = {};

function Harness({ items }: { items: Chip[] }) {
  const { ordered, rootRef, widths } = useChipPacking(items);
  seen = ordered.map((item) => item.key);
  measured = widths;
  return (
    <div ref={rootRef}>
      {ordered.map((item) => (
        <span key={item.key} role="listitem">
          {item.key}
        </span>
      ))}
    </div>
  );
}

const chips = (...keys: string[]): Chip[] => keys.map((key) => ({ key }));

describe('useChipPacking', () => {
  beforeEach(() => {
    for (const key of Object.keys(widthByLabel)) {
      delete widthByLabel[key];
    }
    seen = [];
  });

  it('leaves the order alone while nothing can be measured', () => {
    render(<Harness items={chips('a', 'b', 'c')} />);
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('puts the widest chip first once every chip has been measured', () => {
    Object.assign(widthByLabel, { a: 40, b: 120, c: 80 });
    render(<Harness items={chips('a', 'b', 'c')} />);
    expect(seen).toEqual(['b', 'c', 'a']);
  });

  /* A partial sort would shuffle on each pass and never settle, so a chip that
     has not been measured holds the whole order back. */
  it('waits for the last chip rather than sorting what it has', () => {
    Object.assign(widthByLabel, { a: 40, b: 120 });
    render(<Harness items={chips('a', 'b', 'c')} />);
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('settles instead of oscillating', () => {
    Object.assign(widthByLabel, { a: 40, b: 120, c: 80 });
    const { rerender } = render(<Harness items={chips('a', 'b', 'c')} />);
    const settled = seen;
    rerender(<Harness items={chips('a', 'b', 'c')} />);
    expect(seen).toEqual(settled);
  });

  it('reorders when a chip joins', () => {
    Object.assign(widthByLabel, { a: 40, b: 120, c: 80, d: 200 });
    const items = chips('a', 'b', 'c');
    const { rerender } = render(<Harness items={items} />);
    expect(seen).toEqual(['b', 'c', 'a']);

    act(() => {
      rerender(<Harness items={chips('a', 'b', 'c', 'd')} />);
    });
    expect(seen).toEqual(['d', 'b', 'c', 'a']);
  });

  /* Widths are keyed by chip id and would otherwise outlive the chip, growing
     with every chip the composer has ever shown. */
  it('forgets the width of a chip that left', () => {
    Object.assign(widthByLabel, { a: 40, b: 120, c: 80 });
    const { rerender } = render(<Harness items={chips('a', 'b', 'c')} />);
    expect(Object.keys(measured).sort()).toEqual(['a', 'b', 'c']);

    act(() => {
      rerender(<Harness items={chips('a', 'c')} />);
    });
    expect(Object.keys(measured).sort()).toEqual(['a', 'c']);
  });

  it('re-measures a chip that left and came back narrower', () => {
    Object.assign(widthByLabel, { a: 40, b: 120, c: 80 });
    const { rerender } = render(<Harness items={chips('a', 'b', 'c')} />);
    expect(seen).toEqual(['b', 'c', 'a']);

    act(() => {
      rerender(<Harness items={chips('a', 'c')} />);
    });

    widthByLabel.b = 10;
    act(() => {
      rerender(<Harness items={chips('a', 'b', 'c')} />);
    });
    expect(seen).toEqual(['c', 'a', 'b']);
  });

  it('handles an empty list', () => {
    render(<Harness items={[]} />);
    expect(seen).toEqual([]);
  });
});

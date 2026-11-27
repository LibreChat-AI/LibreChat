/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import Gauge from '../Gauge';

const SIZE = 20;
const STROKE_WIDTH = 2.5;
const CIRCUMFERENCE = 2 * Math.PI * ((SIZE - STROKE_WIDTH) / 2);

function ring(percent: number, indeterminate = false): string | null {
  const { container } = render(<Gauge percent={percent} indeterminate={indeterminate} />);
  const fill = container.querySelectorAll('circle')[1];
  return fill.getAttribute('stroke-dashoffset');
}

describe('Gauge', () => {
  it('holds the ring still while the figure moves within one percent', () => {
    const drawn = ring(40);
    expect(ring(39.6)).toBe(drawn);
    expect(ring(40.2)).toBe(drawn);
    expect(ring(40.4)).toBe(drawn);
  });

  it('moves the ring when the figure reaches the next percent', () => {
    expect(ring(40.6)).toBe(ring(41));
    expect(ring(41)).not.toBe(ring(40));
    expect(Number(ring(41))).toBeCloseTo(CIRCUMFERENCE * 0.59);
  });

  it('draws the first percent for any usage, and nothing for none', () => {
    expect(ring(0.2)).toBe(ring(1));
    expect(Number(ring(0))).toBeCloseTo(CIRCUMFERENCE);
  });

  it('fills the ring at the limit and empties it when the limit is unknown', () => {
    expect(Number(ring(100))).toBeCloseTo(0);
    expect(Number(ring(60, true))).toBeCloseTo(CIRCUMFERENCE);
  });

  it('keeps the tone on the exact figure, not the drawn one', () => {
    const { container } = render(<Gauge percent={75.4} indeterminate={false} />);
    expect(container.querySelectorAll('circle')[1]).toHaveClass('stroke-status-warning');
  });
});

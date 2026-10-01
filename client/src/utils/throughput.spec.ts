import {
  formatRate,
  windowedRate,
  averageRate,
  formatSeconds,
  appendBounded,
  sparklinePoints,
} from './throughput';

describe('windowedRate', () => {
  it('returns 0 with fewer than two samples', () => {
    expect(windowedRate([], 1000)).toBe(0);
    expect(windowedRate([{ at: 0, tokens: 10 }], 1000)).toBe(0);
  });

  it('averages over the trailing window against now', () => {
    const samples = [
      { at: 0, tokens: 0 },
      { at: 1000, tokens: 50 },
      { at: 2000, tokens: 100 },
      { at: 3000, tokens: 200 },
    ];
    /** baseline is the newest sample at or before now − 2000 (t=1000) */
    expect(windowedRate(samples, 3000, 2000)).toBe(75);
  });

  it('falls back to the oldest sample when the stream is younger than one window', () => {
    const samples = [
      { at: 0, tokens: 0 },
      { at: 500, tokens: 40 },
    ];
    expect(windowedRate(samples, 500, 2000)).toBe(80);
  });

  it('decays toward zero when no new tokens arrive', () => {
    const samples = [
      { at: 0, tokens: 0 },
      { at: 1000, tokens: 100 },
    ];
    expect(windowedRate(samples, 1000, 2000)).toBe(100);
    expect(windowedRate(samples, 2000, 2000)).toBe(50);
    expect(windowedRate(samples, 3000, 2000)).toBe(0);
  });

  it('clamps a dip below the baseline to zero', () => {
    const samples = [
      { at: 0, tokens: 120 },
      { at: 500, tokens: 100 },
    ];
    expect(windowedRate(samples, 500, 2000)).toBe(0);
  });

  it('returns 0 when the samples carry no elapsed time', () => {
    const samples = [
      { at: 1000, tokens: 0 },
      { at: 1000, tokens: 300 },
    ];
    expect(windowedRate(samples, 1000, 2000)).toBe(0);
  });
});

describe('averageRate', () => {
  it('divides output tokens by the duration in seconds', () => {
    expect(averageRate(300, 6000)).toBe(50);
  });

  it('returns 0 for a non-positive duration', () => {
    expect(averageRate(300, 0)).toBe(0);
    expect(averageRate(300, -1)).toBe(0);
  });
});

describe('formatRate', () => {
  it('keeps one decimal under ten and rounds above', () => {
    expect(formatRate(3.456)).toBe('3.5');
    expect(formatRate(9.99)).toBe('10.0');
    expect(formatRate(42.4)).toBe('42');
    expect(formatRate(42.5)).toBe('43');
  });

  it('renders non-finite or negative input as zero', () => {
    expect(formatRate(Number.NaN)).toBe('0.0');
    expect(formatRate(-5)).toBe('0.0');
  });
});

describe('formatSeconds', () => {
  it('renders milliseconds as seconds with one decimal', () => {
    expect(formatSeconds(1234)).toBe('1.2');
    expect(formatSeconds(0)).toBe('0.0');
  });
});

describe('appendBounded', () => {
  it('appends without mutating the input', () => {
    const input = [1, 2];
    const next = appendBounded(input, 3, 5);
    expect(next).toEqual([1, 2, 3]);
    expect(input).toEqual([1, 2]);
  });

  it('drops the oldest entries past the bound', () => {
    expect(appendBounded([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });
});

describe('sparklinePoints', () => {
  it('returns an empty string for no values', () => {
    expect(sparklinePoints([], 48, 12)).toBe('');
  });

  it('scales to the peak and spreads points across the width', () => {
    expect(sparklinePoints([0, 50, 100], 48, 12)).toBe('0.0,12.0 24.0,6.0 48.0,0.0');
  });

  it('draws a flat history along the baseline', () => {
    expect(sparklinePoints([0, 0], 48, 12)).toBe('0.0,12.0 48.0,12.0');
  });

  it('places a single value at the origin column', () => {
    expect(sparklinePoints([30], 48, 12)).toBe('0.0,0.0');
  });
});

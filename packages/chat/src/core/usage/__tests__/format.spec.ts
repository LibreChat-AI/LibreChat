import { formatTokens } from '../format';

describe('formatTokens', () => {
  it('renders malformed token counts as a bounded zero', () => {
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0');
    expect(formatTokens(-10)).toBe('0');
  });

  it('uses compact notation without a trailing .0', () => {
    const compact = new Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    });
    expect(formatTokens(950)).toBe(compact.format(950));
    expect(formatTokens(32_000)).toBe(compact.format(32_000));
    expect(formatTokens(32_000)).not.toMatch(/\.0/);
    expect(formatTokens(1_250)).toBe(compact.format(1_250));
  });
});

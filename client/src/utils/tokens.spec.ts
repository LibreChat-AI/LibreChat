import { formatCost, formatTokens } from './tokens';

describe('formatTokens', () => {
  it('renders malformed token counts as a bounded zero', () => {
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0');
    expect(formatTokens(-10)).toBe('0');
  });
});

describe('formatCost', () => {
  it('formats across magnitude bands (USD default, unchanged)', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0.0523)).toBe('$0.0523');
    expect(formatCost(1.234)).toBe('$1.23');
  });

  it('applies the static USD→local rate', () => {
    expect(formatCost(2, { code: 'USD', rate: 0.5 })).toBe('$1.00');
    expect(formatCost(10, { code: 'USD', rate: 0.1 })).toBe('$1.00');
  });

  it('formats in the configured currency', () => {
    const eur = formatCost(5, { code: 'EUR', rate: 1 });
    expect(eur).toContain('€');
    expect(eur).toContain('5');
  });

  it('respects zero-decimal currencies', () => {
    const jpy = formatCost(5, { code: 'JPY', rate: 1 });
    expect(jpy).toContain('¥');
    expect(jpy).not.toContain('.');
  });

  it('falls back to USD on a malformed currency code', () => {
    expect(formatCost(5, { code: 'invalid', rate: 1 })).toBe('$5.00');
  });

  it('drops the rate too when the currency code is unsupported', () => {
    /** A typo in `code` must not leave a converted amount under the $ symbol. */
    expect(formatCost(10, { code: 'EURO', rate: 0.92 })).toBe('$10.00');
  });

  it('rejects well-formed but non-ISO codes that Intl would accept', () => {
    /** `EUU`/`RMB` are 3 letters so Intl does not throw; the ISO-4217 set must
     *  still reject them and fall back to USD (no converted amount, no rate). */
    expect(formatCost(10, { code: 'EUU', rate: 0.92 })).toBe('$10.00');
    expect(formatCost(10, { code: 'RMB', rate: 0.5 })).toBe('$10.00');
  });

  it('uses the currency minor unit for three-decimal currencies', () => {
    /** KWD has 3 fractional digits, so the tiny threshold is 0.001, not 0.01. */
    const small = formatCost(0.005, { code: 'KWD', rate: 1 });
    expect(small).toContain('0.005');
    expect(small).not.toContain('<');
    expect(formatCost(0.0005, { code: 'KWD', rate: 1 })).toContain('0.001');
  });

  it('falls back to rate 1 when rate is not a finite positive number', () => {
    /** Partial admin override (code set before rate) must never render NaN. */
    const eur = formatCost(10, { code: 'EUR', rate: undefined as unknown as number });
    expect(eur).toContain('€');
    expect(eur).toContain('10');
    expect(eur).not.toContain('NaN');
    expect(formatCost(10, { code: 'USD', rate: Number.NaN })).toBe('$10.00');
  });
});

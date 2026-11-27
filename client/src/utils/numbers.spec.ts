import { sanitizeIntegerInput } from './numbers';

describe('sanitizeIntegerInput', () => {
  test('strips US-style thousands separators', () => {
    expect(sanitizeIntegerInput('120,000')).toBe('120000');
  });

  test('strips EU-style thousands separators', () => {
    expect(sanitizeIntegerInput('120.000')).toBe('120000');
  });

  test('strips spaces and other grouping characters', () => {
    expect(sanitizeIntegerInput('1 200 000')).toBe('1200000');
  });

  test('drops stray non-numeric characters', () => {
    expect(sanitizeIntegerInput('12a3')).toBe('123');
    expect(sanitizeIntegerInput('abc')).toBe('');
  });

  test('preserves an empty string so the field can be cleared', () => {
    expect(sanitizeIntegerInput('')).toBe('');
  });

  test('leaves a clean integer untouched', () => {
    expect(sanitizeIntegerInput('120000')).toBe('120000');
  });

  test('strips a leading minus by default', () => {
    expect(sanitizeIntegerInput('-1')).toBe('1');
  });

  describe('with allowNegative', () => {
    test('preserves a leading minus', () => {
      expect(sanitizeIntegerInput('-1', true)).toBe('-1');
    });

    test('keeps a lone minus so the sign can be typed before the digits', () => {
      expect(sanitizeIntegerInput('-', true)).toBe('-');
    });

    test('only honors a leading minus, not stray ones', () => {
      expect(sanitizeIntegerInput('1-2', true)).toBe('12');
    });

    test('still strips grouping separators around a negative value', () => {
      expect(sanitizeIntegerInput('-12,000', true)).toBe('-12000');
    });

    test('leaves a positive value unsigned', () => {
      expect(sanitizeIntegerInput('120000', true)).toBe('120000');
    });
  });
});

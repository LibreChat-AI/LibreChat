/* eslint-disable @typescript-eslint/ban-ts-comment */
import { isEnabled, optionalEnabled } from './common';

describe('isEnabled', () => {
  test('should return true when input is "true"', () => {
    expect(isEnabled('true')).toBe(true);
  });

  test('should return true when input is "TRUE"', () => {
    expect(isEnabled('TRUE')).toBe(true);
  });

  test('should return true when input is true', () => {
    expect(isEnabled(true)).toBe(true);
  });

  test('should return false when input is "false"', () => {
    expect(isEnabled('false')).toBe(false);
  });

  test('should return false when input is false', () => {
    expect(isEnabled(false)).toBe(false);
  });

  test('should return false when input is null', () => {
    expect(isEnabled(null)).toBe(false);
  });

  test('should return false when input is undefined', () => {
    expect(isEnabled()).toBe(false);
  });

  test('should return false when input is an empty string', () => {
    expect(isEnabled('')).toBe(false);
  });

  test('should return false when input is a whitespace string', () => {
    expect(isEnabled('   ')).toBe(false);
  });

  test('should return false when input is a number', () => {
    // @ts-expect-error
    expect(isEnabled(123)).toBe(false);
  });

  test('should return false when input is an object', () => {
    // @ts-expect-error
    expect(isEnabled({})).toBe(false);
  });

  test('should return false when input is an array', () => {
    // @ts-expect-error
    expect(isEnabled([])).toBe(false);
  });
});

describe('optionalEnabled', () => {
  test('should return undefined when input is missing', () => {
    expect(optionalEnabled()).toBeUndefined();
  });

  test('should return undefined when input is null', () => {
    expect(optionalEnabled(null)).toBeUndefined();
  });

  test('should return undefined when input is an empty string', () => {
    expect(optionalEnabled('')).toBeUndefined();
  });

  test('should return undefined when input is whitespace', () => {
    expect(optionalEnabled('   ')).toBeUndefined();
  });

  test('should return true when input is "true"', () => {
    expect(optionalEnabled('true')).toBe(true);
  });

  test('should return true when input is "TRUE"', () => {
    expect(optionalEnabled('TRUE')).toBe(true);
  });

  test('should return true when input is true', () => {
    expect(optionalEnabled(true)).toBe(true);
  });

  test('should return false when input is "false"', () => {
    expect(optionalEnabled('false')).toBe(false);
  });

  test('should return false when input is false', () => {
    expect(optionalEnabled(false)).toBe(false);
  });
});

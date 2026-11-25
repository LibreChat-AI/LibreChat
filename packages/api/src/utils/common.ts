import { AuthType } from 'librechat-data-provider';

/**
 * Checks if the given value is truthy by being either the boolean `true` or a string
 * that case-insensitively matches 'true'.
 *
 * @param value - The value to check.
 * @returns Returns `true` if the value is the boolean `true` or a case-insensitive
 *                    match for the string 'true', otherwise returns `false`.
 * @example
 *
 * isEnabled("True");  // returns true
 * isEnabled("TRUE");  // returns true
 * isEnabled(true);    // returns true
 * isEnabled("false"); // returns false
 * isEnabled(false);   // returns false
 * isEnabled(null);    // returns false
 * isEnabled();        // returns false
 */
export function isEnabled(value?: string | boolean | null | undefined): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.toLowerCase().trim() === 'true';
  }
  return false;
}

/**
 * Like {@link isEnabled}, but missing or blank values stay unset so the caller
 * can apply its own default instead of forcing `false`.
 */
export function optionalEnabled(value?: string | boolean | null | undefined): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return isEnabled(value);
}

/**
 * Checks if the provided value is 'user_provided'.
 *
 * @param value - The value to check.
 * @returns - Returns true if the value is 'user_provided', otherwise false.
 */
export const isUserProvided = (value?: string): boolean => value === AuthType.USER_PROVIDED;

/**
 * @param values
 */
export function optionalChainWithEmptyCheck(
  ...values: (string | number | undefined)[]
): string | number | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return values[values.length - 1];
}

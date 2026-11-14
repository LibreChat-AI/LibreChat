/** Joins class names. Components in this package do not call `cn`. */
export function classes(...values: Array<string | false | null | undefined>): string {
  return values
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
}

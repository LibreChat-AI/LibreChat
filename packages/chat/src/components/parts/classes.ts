/** Joins class names. Package parts do not call `cn()`, so conditional classes are concatenated. */
export function classes(...parts: Array<string | false | null | undefined>): string {
  let result = '';
  for (const part of parts) {
    if (part == null || part === false || part === '') {
      continue;
    }
    result = result === '' ? part : `${result} ${part}`;
  }
  return result;
}

/** i18next selects cardinal and ordinal suffixes from the base key's count. */
export function isTranslationReferenced(
  key: string,
  isReferenced: (key: string) => boolean,
): boolean {
  if (isReferenced(key)) return true;
  const base = key.replace(/(?:_ordinal)?_(zero|one|two|few|many|other)$/, '');
  return base !== key && isReferenced(base);
}

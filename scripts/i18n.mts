const PLURAL_SUFFIX = /(?:_ordinal)?_(zero|one|two|few|many|other)$/;

/** i18next selects cardinal and ordinal suffixes from the base key's count. */
export function isTranslationReferenced(
  key: string,
  isReferenced: (key: string) => boolean,
): boolean {
  if (isReferenced(key)) return true;
  const base = key.replace(PLURAL_SUFFIX, '');
  return base !== key && isReferenced(base);
}

/**
 * Whether source that produced `tokens` refers to a key: the key is one of its
 * `[A-Za-z0-9_]+` runs, or sits inside one. Keys are made only of those
 * characters, so this is the question "does the key occur anywhere in the
 * source" asked once for all keys.
 */
export function referenceIn(tokens: ReadonlySet<string>): (key: string) => boolean {
  let list: string[] | null = null;
  return (key) => {
    if (tokens.has(key)) return true;
    list ??= [...tokens];
    return list.some((token) => token.includes(key));
  };
}

/** The translations the source behind `tokens` refers to, plural forms with their base key. */
export function referencedTranslations<T>(
  translations: Readonly<Record<string, T>>,
  tokens: ReadonlySet<string>,
): Record<string, T> {
  const isReferenced = referenceIn(tokens);
  const picked: Record<string, T> = {};
  for (const [key, value] of Object.entries(translations)) {
    if (isTranslationReferenced(key, isReferenced)) picked[key] = value;
  }
  return picked;
}

/** Whether a key named in source has copy: its own, or the plural forms i18next picks from. */
export function hasTranslation(
  key: string,
  translations: Readonly<Record<string, unknown>>,
): boolean {
  if (key in translations) return true;
  return Object.keys(translations).some(
    (candidate) => candidate.startsWith(`${key}_`) && candidate.replace(PLURAL_SUFFIX, '') === key,
  );
}

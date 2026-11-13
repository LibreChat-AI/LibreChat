/**
 * Which supported locale a requested language resolves to. Kept free of side effects and of
 * i18next, so the build can resolve the HTML shell's loading label with the same rules
 * (`bootLoadingLabels` in vite.config.ts).
 */
export const supportedLocales = [
  'ar',
  'bo',
  'bs',
  'ca',
  'cs',
  'da',
  'de',
  'en',
  'es',
  'et',
  'fa',
  'fi',
  'fr',
  'he',
  'hi',
  'hu',
  'hy',
  'id',
  'is',
  'it',
  'ja',
  'ka',
  'ko',
  'lt',
  'lv',
  'mr',
  'nb',
  'nl',
  'nn',
  'pl',
  'pt-BR',
  'pt-PT',
  'ru',
  'sk',
  'sl',
  'sv',
  'ta',
  'th',
  'tr',
  'ug',
  'uk',
  'vi',
  'zh-Hans',
  'zh-Hant',
] as const;

export type SupportedLocale = (typeof supportedLocales)[number];

const localeByLowercase = supportedLocales.reduce<Record<string, SupportedLocale>>(
  (acc, locale) => {
    acc[locale.toLowerCase()] = locale;
    return acc;
  },
  {},
);

export const localeAliases: Record<string, SupportedLocale> = {
  'ar-eg': 'ar',
  'ca-es': 'ca',
  'cs-cz': 'cs',
  'da-dk': 'da',
  'de-de': 'de',
  'en-us': 'en',
  'es-es': 'es',
  'et-ee': 'et',
  'fa-ir': 'fa',
  'fi-fi': 'fi',
  'fr-fr': 'fr',
  'he-he': 'he',
  'he-il': 'he',
  'hu-hu': 'hu',
  'hy-am': 'hy',
  'id-id': 'id',
  'it-it': 'it',
  'ja-jp': 'ja',
  'ka-ge': 'ka',
  'ko-kr': 'ko',
  'lt-lt': 'lt',
  'lv-lv': 'lv',
  'nl-nl': 'nl',
  'pl-pl': 'pl',
  pt: 'pt-PT',
  'ru-ru': 'ru',
  'sv-se': 'sv',
  'th-th': 'th',
  'tr-tr': 'tr',
  'uk-ua': 'uk',
  'vi-vn': 'vi',
  zh: 'zh-Hans',
  'zh-cn': 'zh-Hans',
  'zh-sg': 'zh-Hans',
  'zh-tw': 'zh-Hant',
  'zh-hk': 'zh-Hant',
  'zh-mo': 'zh-Hant',
};

/** A requested language (`de-DE`, `zh_TW`, `pt`) to the supported locale the app loads. */
export function resolveLocale(requested?: string | null): SupportedLocale {
  if (!requested) {
    return 'en';
  }

  const normalized = requested.replace(/_/g, '-').toLowerCase();
  const exact = localeByLowercase[normalized];
  if (exact) {
    return exact;
  }

  const alias = localeAliases[normalized];
  if (alias) {
    return alias;
  }

  const base = normalized.split('-')[0];
  return localeByLowercase[base] ?? localeAliases[base] ?? 'en';
}

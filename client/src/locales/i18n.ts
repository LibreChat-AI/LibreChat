import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import translationEn from './en/translation.json';

export const defaultNS = 'translation';

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
  'th',
  'tr',
  'ug',
  'uk',
  'vi',
  'zh-Hans',
  'zh-Hant',
] as const;

export type SupportedLocale = (typeof supportedLocales)[number];
export type TranslationResource = Record<string, string>;

export const resources = {
  en: { translation: translationEn },
} as const;

const localeLoaders: Record<
  Exclude<SupportedLocale, 'en'>,
  () => Promise<{ default: TranslationResource }>
> = {
  ar: () => import('./ar/translation.json'),
  bo: () => import('./bo/translation.json'),
  bs: () => import('./bs/translation.json'),
  ca: () => import('./ca/translation.json'),
  cs: () => import('./cs/translation.json'),
  da: () => import('./da/translation.json'),
  de: () => import('./de/translation.json'),
  es: () => import('./es/translation.json'),
  et: () => import('./et/translation.json'),
  fa: () => import('./fa/translation.json'),
  fi: () => import('./fi/translation.json'),
  fr: () => import('./fr/translation.json'),
  he: () => import('./he/translation.json'),
  hu: () => import('./hu/translation.json'),
  hy: () => import('./hy/translation.json'),
  id: () => import('./id/translation.json'),
  is: () => import('./is/translation.json'),
  it: () => import('./it/translation.json'),
  ja: () => import('./ja/translation.json'),
  ka: () => import('./ka/translation.json'),
  ko: () => import('./ko/translation.json'),
  lt: () => import('./lt/translation.json'),
  lv: () => import('./lv/translation.json'),
  nb: () => import('./nb/translation.json'),
  nl: () => import('./nl/translation.json'),
  nn: () => import('./nn/translation.json'),
  pl: () => import('./pl/translation.json'),
  'pt-BR': () => import('./pt-BR/translation.json'),
  'pt-PT': () => import('./pt-PT/translation.json'),
  ru: () => import('./ru/translation.json'),
  sk: () => import('./sk/translation.json'),
  sl: () => import('./sl/translation.json'),
  sv: () => import('./sv/translation.json'),
  th: () => import('./th/translation.json'),
  tr: () => import('./tr/translation.json'),
  ug: () => import('./ug/translation.json'),
  uk: () => import('./uk/translation.json'),
  vi: () => import('./vi/translation.json'),
  'zh-Hans': () => import('./zh-Hans/translation.json'),
  'zh-Hant': () => import('./zh-Hant/translation.json'),
};

const localeByLowercase = supportedLocales.reduce<Record<string, SupportedLocale>>(
  (acc, locale) => {
    acc[locale.toLowerCase()] = locale;
    return acc;
  },
  {},
);

const localeAliases: Record<string, SupportedLocale> = {
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

const loadedLocales = new Set<SupportedLocale>(['en']);
const loadingLocales: Partial<Record<SupportedLocale, Promise<SupportedLocale>>> = {};
let languageRequestId = 0;
let latestRequestedLocale: SupportedLocale = 'en';

function readCookie(name: string) {
  if (typeof document === 'undefined') {
    return undefined;
  }

  const prefix = `${name}=`;
  return document.cookie
    .split(';')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(prefix))
    ?.slice(prefix.length);
}

function readStoredLanguage() {
  if (typeof localStorage === 'undefined') {
    return undefined;
  }

  const raw = localStorage.getItem('lang');
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : raw;
  } catch {
    return raw;
  }
}

function getNavigatorLanguage() {
  if (typeof navigator === 'undefined') {
    return 'en';
  }

  return navigator.language || navigator.languages?.[0] || 'en';
}

export function normalizeLocale(locale?: string | null): SupportedLocale {
  const requested = locale === 'auto' ? getNavigatorLanguage() : locale;
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

export function detectInitialLanguage() {
  const cookieLang = readCookie('lang');
  const storedLang = readStoredLanguage();
  return normalizeLocale(cookieLang || storedLang || getNavigatorLanguage());
}

export async function ensureLocale(locale?: string | null): Promise<SupportedLocale> {
  const normalized = normalizeLocale(locale);

  if (normalized === 'en') {
    return normalized;
  }

  if (loadedLocales.has(normalized)) {
    return normalized;
  }

  if (i18n.hasResourceBundle(normalized, defaultNS)) {
    loadedLocales.add(normalized);
    return normalized;
  }

  if (!loadingLocales[normalized]) {
    const loader = localeLoaders[normalized];
    loadingLocales[normalized] = loader()
      .then((module) => {
        i18n.addResourceBundle(normalized, defaultNS, module.default, true, true);
        loadedLocales.add(normalized);
        return normalized;
      })
      .catch((error): SupportedLocale => {
        console.error(`[i18n] Failed to load locale "${normalized}"`, error);
        return 'en';
      })
      .finally(() => {
        delete loadingLocales[normalized];
      });
  }

  return loadingLocales[normalized] ?? Promise.resolve('en');
}

export function __setLocaleLoaderForTests(
  locale: Exclude<SupportedLocale, 'en'>,
  loader: () => Promise<{ default: TranslationResource }>,
) {
  const previousLoader = localeLoaders[locale];
  localeLoaders[locale] = loader;
  return () => {
    localeLoaders[locale] = previousLoader;
  };
}

export function __resetLocaleForTests(locale: Exclude<SupportedLocale, 'en'>) {
  delete loadingLocales[locale];
  loadedLocales.delete(locale);
  if (i18n.hasResourceBundle(locale, defaultNS)) {
    i18n.removeResourceBundle(locale, defaultNS);
  }
}

export function syncDocumentLanguage(locale: SupportedLocale) {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.lang = locale;
  document.documentElement.dir = i18n.dir(locale);
}

export const i18nInitPromise = i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: {
    'zh-TW': ['zh-Hant', 'en'],
    'zh-HK': ['zh-Hant', 'en'],
    zh: ['zh-Hans', 'en'],
    default: ['en'],
  },
  fallbackNS: defaultNS,
  ns: [defaultNS],
  debug: false,
  defaultNS,
  resources,
  supportedLngs: [...supportedLocales],
  partialBundledLanguages: true,
  load: 'currentOnly',
  react: { useSuspense: false },
  interpolation: { escapeValue: false },
});

export async function changeLanguageSafely(locale?: string | null) {
  const requestId = ++languageRequestId;
  const requestedLocale = normalizeLocale(locale);
  latestRequestedLocale = requestedLocale;
  await i18nInitPromise;

  const loadedLocale = await ensureLocale(requestedLocale);
  if (requestId !== languageRequestId) {
    return i18n.language;
  }

  await i18n.changeLanguage(loadedLocale);
  if (requestId !== languageRequestId) {
    const latestLocale = await ensureLocale(latestRequestedLocale);
    await i18n.changeLanguage(latestLocale);
    syncDocumentLanguage(latestLocale);
    return i18n.language;
  }

  syncDocumentLanguage(loadedLocale);
  return loadedLocale;
}

export async function initializeI18n() {
  const initialLanguage = detectInitialLanguage();
  await changeLanguageSafely(initialLanguage);
  return initialLanguage;
}

export default i18n;

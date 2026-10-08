import type { ClockFormatPreference } from '~/store/clockFormat';
import type { WeekStartPreference } from '~/store/weekStart';

/**
 * The locale "System" means: the runtime's own, NOT the app's translation locale.
 * `i18n.language` is normalized down to a translation bundle (`en-GB` and `en-AU`
 * both become `en`, `fr-CA` becomes `fr`), which drops exactly the regional part
 * these two settings read, and would tell a British user their clock is 12-hour.
 * Returns undefined when the runtime cannot say, which every caller below already
 * treats as "let Intl pick its own default": the same answer by a shorter route.
 */
let cachedSystemLocale: string | undefined;
let systemLocaleResolved = false;

export const systemLocale = (): string | undefined => {
  // Resolved once: the runtime locale cannot change without a reload, and every
  // message timestamp mounts a hook that asks, so an uncached answer builds a
  // formatter per rendered message.
  if (systemLocaleResolved) {
    return cachedSystemLocale;
  }
  systemLocaleResolved = true;
  try {
    cachedSystemLocale = new Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    cachedSystemLocale = globalThis.navigator?.language;
  }
  return cachedSystemLocale;
};

/** Whether a locale shows a meridiem, which is what "System" resolves to. Asked of
 *  `Intl` rather than kept as a region list, because that is the same question every
 *  date this app formats already answers for itself. Defaults to a 12-hour clock when
 *  the runtime cannot say, matching `Intl`'s own behaviour for an unknown locale. */
const meridiemCache = new Map<string, boolean>();

export const localeUsesMeridiem = (locale?: string): boolean => {
  const cacheKey = locale ?? '';
  const cached = meridiemCache.get(cacheKey);
  if (cached != null) {
    return cached;
  }
  let usesMeridiem = true;
  try {
    usesMeridiem =
      new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12 === true;
  } catch {
    usesMeridiem = true;
  }
  meridiemCache.set(cacheKey, usesMeridiem);
  return usesMeridiem;
};

/**
 * Resolves the "Clock format" setting to a concrete `hour12` boolean for a
 * single call site. 'system' defers to the browser's locale; '12h'/'24h'
 * override it explicitly, which is the entire point of the setting existing.
 */
export const resolveHour12 = (preference: ClockFormatPreference, locale?: string): boolean => {
  if (preference === '12h') {
    return true;
  }
  if (preference === '24h') {
    return false;
  }
  return localeUsesMeridiem(locale);
};

/** First day of the week on the same 0-6 Sunday-first scale the schedule cadence
 *  uses (the cron day-of-week field). Deliberately not narrowed to Sunday/Monday:
 *  the setting offers only those two, but its 'system' branch reports whatever the
 *  locale says, and several (`ar-EG`, `fa-IR`) start the week on Saturday. */
export type WeekStartDay = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Locale-only guess at the first day of the week, on the scale above.
 *
 * `Intl.Locale.prototype.getWeekInfo` (Baseline 2024) reports `firstDay` on a
 * 1-7 ISO scale where 7 = Sunday; `% 7` folds that back to this app's 0-6
 * scale. Engines without it (older Safari/Firefox) fall back to region lists
 * generated from CLDR's own weekData (every territory whose `und-XX` week does
 * not start Monday, deprecated codes included), with Monday, the ISO 8601
 * default, otherwise. Regenerate by asking `getWeekInfo()` for each region on a
 * current engine if CLDR moves a territory again.
 */
const SATURDAY_FIRST_FALLBACK_REGIONS = [
  'AF',
  'BH',
  'DJ',
  'DZ',
  'EG',
  'IQ',
  'IR',
  'JO',
  'KW',
  'LY',
  'OM',
  'QA',
  'SD',
  'SY',
];

const SUNDAY_FIRST_FALLBACK_REGIONS = [
  'AG',
  'AS',
  'BD',
  'BR',
  'BS',
  'BT',
  'BU',
  'BW',
  'BZ',
  'CA',
  'CO',
  'DM',
  'DO',
  'ET',
  'GT',
  'GU',
  'HK',
  'HN',
  'ID',
  'IL',
  'IN',
  'IS',
  'JM',
  'JP',
  'JT',
  'KE',
  'KH',
  'KR',
  'LA',
  'MH',
  'MI',
  'MM',
  'MO',
  'MT',
  'MX',
  'MZ',
  'NI',
  'NP',
  'NT',
  'PA',
  'PE',
  'PH',
  'PK',
  'PR',
  'PT',
  'PU',
  'PY',
  'PZ',
  'RH',
  'SA',
  'SG',
  'SV',
  'TH',
  'TT',
  'TW',
  'UM',
  'US',
  'VE',
  'VI',
  'WK',
  'WS',
  'YD',
  'YE',
  'ZA',
  'ZW',
];

const FALLBACK_REGION_WEEK_START = new Map<string, WeekStartDay>([
  ...SATURDAY_FIRST_FALLBACK_REGIONS.map((region): [string, WeekStartDay] => [region, 6]),
  ...SUNDAY_FIRST_FALLBACK_REGIONS.map((region): [string, WeekStartDay] => [region, 0]),
  // The Maldives is CLDR's lone Friday-first territory, and the selector offers
  // no Friday override for an affected user to recover with.
  ['MV', 5],
]);

/** `Intl.Locale.prototype.getWeekInfo`/`.weekInfo` (Baseline 2024) predate this
 *  project's TS lib target, so neither member is declared on `Intl.Locale` yet. */
interface LocaleWithWeekInfo extends Intl.Locale {
  getWeekInfo?: () => { firstDay: number };
  weekInfo?: { firstDay: number };
}

/** `globalThis.navigator` rather than the bare global: this module is imported
 *  through `~/utils`, which server-side rendering and plain-node test runners
 *  also load, and a bare `navigator` there is a ReferenceError, not undefined. */
const localeTag = (locale?: string): string => locale ?? globalThis.navigator?.language ?? '';

/** The region subtag, for the fallback heuristic only. `Intl.Locale` where it
 *  parses; otherwise the first subtag SHAPED like a region, because a naive
 *  `split('-')[1]` reads the script subtag of `zh-Hant-TW` as the region. */
const regionOf = (tag: string): string | undefined => {
  try {
    const locale = new Intl.Locale(tag);
    if (locale.region != null) {
      return locale.region.toUpperCase();
    }
    // A bare language tag ('ar', 'fa') names no region, but its LIKELY one is
    // exactly what a heuristic wants: without this, every language-only locale
    // fell through to the Monday default, and `ar` alone reads Saturday-first.
    const likelyRegion = locale.maximize().region;
    if (likelyRegion != null) {
      return likelyRegion.toUpperCase();
    }
  } catch {
    // fall through to the manual scan
  }
  const subtag = tag
    .split('-')
    .slice(1)
    .find((part) => /^[A-Za-z]{2}$/.test(part) || /^\d{3}$/.test(part));
  return subtag?.toUpperCase();
};

export const localeWeekStartsOn = (locale?: string): WeekStartDay => {
  const tag = localeTag(locale);
  try {
    const resolved = new Intl.Locale(tag) as LocaleWithWeekInfo;
    const weekInfo =
      typeof resolved.getWeekInfo === 'function' ? resolved.getWeekInfo() : resolved.weekInfo;
    const firstDay = weekInfo?.firstDay;
    if (firstDay != null && Number.isInteger(firstDay) && firstDay >= 1 && firstDay <= 7) {
      return (firstDay % 7) as WeekStartDay;
    }
  } catch {
    // fall through to the region heuristic below
  }
  const region = regionOf(tag);
  if (region == null) {
    return 1;
  }
  // The mapped days matter doubly here: the type above allows them, but the
  // selector offers no Saturday or Friday override, so a user in `ar-EG` or
  // `dv-MV` on such an engine has no other route back to their own week order.
  return FALLBACK_REGION_WEEK_START.get(region) ?? 1;
};

/** Resolves the "Week starts on" setting to a concrete day index (0 = Sunday, 1 = Monday). */
export const resolveWeekStartsOn = (
  preference: WeekStartPreference,
  locale?: string,
): WeekStartDay => {
  if (preference === 'sunday') {
    return 0;
  }
  if (preference === 'monday') {
    return 1;
  }
  return localeWeekStartsOn(locale);
};

/** Rotates 0-6 (Sunday-first) so it begins at `weekStartsOn`, for rendering a week in order. */
export const rotateWeekFrom = (weekStartsOn: WeekStartDay): number[] => {
  const days = [0, 1, 2, 3, 4, 5, 6];
  return [...days.slice(weekStartsOn), ...days.slice(0, weekStartsOn)];
};

/** Locale-aware message timestamps, formatted once per locale and clock format. */

export type MessageTimestamp = {
  /** Localized relative time, e.g. "2 hours ago". */
  relative: string;
  /** Localized absolute date and time, e.g. "Jun 12, 2026, 3:42 PM". */
  absolute: string;
  /** ISO 8601 string for the `<time>` element's `dateTime` attribute. */
  iso: string;
  /**
   * True when the message is recent enough that the relative form ("10 minutes ago")
   * reads better than the absolute date. Past this window the absolute date is clearer.
   */
  isRecent: boolean;
};

/** Below this age the relative form is preferred over the absolute date. */
const RECENT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Returns true when `value` parses to a valid date. */
export const isValidTimestamp = (value?: string | null): value is string => {
  if (!value) {
    return false;
  }
  return !Number.isNaN(new Date(value).getTime());
};

const RELATIVE_TIME_DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

/**
 * Intl formatters are expensive to construct and every message row formats its
 * timestamp on each render, so they are built once per locale (and clock format).
 */
const resolvedLocales = new Map<string, string | undefined>();
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();
const absoluteFormatters = new Map<string, Intl.DateTimeFormat>();

/** Returns the locale only when it is a syntactically valid BCP-47 tag, else undefined. */
const resolveLocale = (locale?: string): string | undefined => {
  if (!locale) {
    return undefined;
  }
  if (resolvedLocales.has(locale)) {
    return resolvedLocales.get(locale);
  }
  let resolved: string | undefined;
  try {
    Intl.DateTimeFormat.supportedLocalesOf(locale);
    resolved = locale;
  } catch {
    resolved = undefined;
  }
  resolvedLocales.set(locale, resolved);
  return resolved;
};

const getRelativeFormatter = (locale?: string): Intl.RelativeTimeFormat => {
  const key = locale ?? '';
  let formatter = relativeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    relativeFormatters.set(key, formatter);
  }
  return formatter;
};

const getAbsoluteFormatter = (locale?: string, hour12?: boolean): Intl.DateTimeFormat => {
  const key = `${locale ?? ''}|${String(hour12)}`;
  let formatter = absoluteFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      hour12,
    });
    absoluteFormatters.set(key, formatter);
  }
  return formatter;
};

const formatRelativeTime = (from: Date, to: Date, locale?: string): string => {
  const formatter = getRelativeFormatter(locale);
  let duration = (from.getTime() - to.getTime()) / 1000;
  for (const division of RELATIVE_TIME_DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return formatter.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return formatter.format(Math.round(duration), 'year');
};

/**
 * Formats a message timestamp into locale-aware relative and absolute strings.
 * Returns null when the value is missing or unparseable, so callers can skip
 * rendering the timestamp entirely.
 */
export const getMessageTimestamp = (
  value?: string | null,
  locale?: string,
  hour12?: boolean,
): MessageTimestamp | null => {
  if (!isValidTimestamp(value)) {
    return null;
  }

  const date = new Date(value);
  const now = new Date(Date.now());
  const safeLocale = resolveLocale(locale);

  return {
    iso: date.toISOString(),
    relative: formatRelativeTime(date, now, safeLocale),
    absolute: getAbsoluteFormatter(safeLocale, hour12).format(date),
    isRecent: Math.abs(now.getTime() - date.getTime()) < RECENT_THRESHOLD_MS,
  };
};

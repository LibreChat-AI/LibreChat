import type { TranslationKeys } from '~/hooks/useLocalize';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
/** Below this, a decimal carries real information (1.4s reads differently from
 *  1.9s). Above it, the tenth is noise on a number the reader is only
 *  skimming, and it makes the label jitter by a character as it settles. */
const DECIMAL_PRECISION_BELOW_SECONDS = 10;

/** What a duration should render as, in both of the places it is presented. */
export interface RunStepDurationLabels {
  /** Compact form for the visible label, e.g. `1.4s`, `12s`, `2m 5s`. */
  key: TranslationKeys;
  values: Record<string, string | number>;
  /** Spoken form for assistive technology, e.g. "took 1.4 seconds". */
  announcedKey: TranslationKeys;
  announcedValues: Record<string, string | number>;
}

/**
 * Every interpolated number goes through this, not just the fractional one:
 * a raw JS number hardcodes en-US conventions into every locale — the
 * decimal point ("1.4s" where the convention is "1,4 s") and the digits
 * themselves (Arabic and Persian locales write localized digits, which a raw
 * `1` silently reverts to ASCII). Translators cannot fix a number formatted
 * in code, so it is formatted per-locale here, following `MessageTimestamp`'s
 * pattern of threading `i18n.language` into the util. The guard covers
 * malformed language tags, which `Intl` throws on.
 */
function formatDurationValue(value: number, language?: string): string {
  try {
    return new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value);
  } catch {
    return String(value);
  }
}

/**
 * Resolve the localization keys and interpolation values for a run-step
 * duration.
 *
 * Returns keys rather than strings so the caller localizes once, at the point
 * of render, and so this stays testable without a translation context.
 *
 * The visible and announced forms are produced together, deliberately: they
 * are the same fact presented twice, and deriving them apart is exactly how
 * the tool cards drifted before (see the label/announcement split called out
 * in AI-1810). The announced form rounds to whole minutes above a minute —
 * the precise value stays on the button, which assistive technology reads
 * when the reader navigates to it.
 */
export function getRunStepDurationLabels(
  durationMs: number,
  language?: string,
): RunStepDurationLabels {
  const totalSeconds = durationMs / MS_PER_SECOND;

  /** Branch on the rounded value, not the raw one, so 59.6s renders as
   *  `1m 0s` rather than the nonsensical `60s`. */
  if (Math.round(totalSeconds) < SECONDS_PER_MINUTE) {
    const seconds =
      totalSeconds < DECIMAL_PRECISION_BELOW_SECONDS
        ? Number(totalSeconds.toFixed(1))
        : Math.round(totalSeconds);
    /** Plural selection stays on the numeric value; only the interpolated
     *  text is locale-formatted. */
    const formatted = formatDurationValue(seconds, language);
    return {
      key: 'com_ui_duration_seconds',
      values: { 0: formatted },
      /** The caller picks the plural form explicitly, matching the
       *  `com_ui_tools_count` / `_one` convention already used across the
       *  locale files, rather than relying on i18next's plural resolution. */
      announcedKey:
        seconds === 1
          ? 'com_ui_duration_announced_seconds_one'
          : 'com_ui_duration_announced_seconds',
      announcedValues: { count: formatted },
    };
  }

  const wholeSeconds = Math.round(totalSeconds);
  const minutes = Math.floor(wholeSeconds / SECONDS_PER_MINUTE);
  const seconds = wholeSeconds % SECONDS_PER_MINUTE;
  const announcedMinutes = Math.round(totalSeconds / SECONDS_PER_MINUTE);
  return {
    key: 'com_ui_duration_minutes',
    values: {
      0: formatDurationValue(minutes, language),
      1: formatDurationValue(seconds, language),
    },
    announcedKey:
      announcedMinutes === 1
        ? 'com_ui_duration_announced_minutes_one'
        : 'com_ui_duration_announced_minutes',
    announcedValues: { count: formatDurationValue(announcedMinutes, language) },
  };
}

/**
 * The streaming elapsed indicator's variant of the duration labels: the same
 * locale-formatted visible form, with the spoken form phrased for a run still
 * in progress ("5 seconds elapsed") rather than a settled one ("took 5
 * seconds"). Produced here, beside `getRunStepDurationLabels`, so both forms
 * keep sharing one per-locale number formatter.
 */
export function getElapsedDurationLabels(
  durationMs: number,
  language?: string,
): RunStepDurationLabels {
  const { key, values } = getRunStepDurationLabels(durationMs, language);
  const totalSeconds = durationMs / MS_PER_SECOND;

  if (Math.round(totalSeconds) < SECONDS_PER_MINUTE) {
    const seconds = Math.round(totalSeconds);
    return {
      key,
      values,
      announcedKey:
        seconds === 1 ? 'com_ui_elapsed_announced_seconds_one' : 'com_ui_elapsed_announced_seconds',
      announcedValues: { count: formatDurationValue(seconds, language) },
    };
  }

  const announcedMinutes = Math.round(totalSeconds / SECONDS_PER_MINUTE);
  return {
    key,
    values,
    announcedKey:
      announcedMinutes === 1
        ? 'com_ui_elapsed_announced_minutes_one'
        : 'com_ui_elapsed_announced_minutes',
    announcedValues: { count: formatDurationValue(announcedMinutes, language) },
  };
}

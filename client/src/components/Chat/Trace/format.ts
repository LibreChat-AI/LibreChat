import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TraceNode } from './model';
import useClockFormat from '~/hooks/useClockFormat';

/** Shown for a finished record the backend gave no end, which has no measurable duration. */
const UNKNOWN_DURATION = '—';

export type TraceFormat = {
  duration: (ms: number) => string;
  clock: (epochMs: number) => string;
};

const formats = new Map<string, TraceFormat>();

/** A malformed language tag makes `Intl` throw; it falls back to the runtime's own locale. */
function supportedLocale(locale?: string): string | undefined {
  if (!locale) {
    return undefined;
  }
  try {
    return Intl.DateTimeFormat.supportedLocalesOf(locale).length > 0 ? locale : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Duration and clock formatters for one locale and clock preference. Built once
 * per pair, since every visible ledger row formats several values per render.
 */
export function createTraceFormat(language?: string, hour12?: boolean): TraceFormat {
  const locale = supportedLocale(language);
  const key = `${locale ?? ''}|${hour12 ?? ''}`;
  const cached = formats.get(key);
  if (cached) {
    return cached;
  }

  const unit = (name: string, maximumFractionDigits: number) =>
    new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: name,
      unitDisplay: 'narrow',
      maximumFractionDigits,
    });
  const milliseconds = unit('millisecond', 0);
  const seconds = unit('second', 2);
  const wholeSeconds = unit('second', 0);
  const minutes = unit('minute', 0);
  const hours = unit('hour', 0);
  const clock = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12,
  });

  const format: TraceFormat = {
    duration: (ms) => {
      const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
      if (value < 1000) {
        return milliseconds.format(value);
      }
      if (value < 60_000) {
        return seconds.format(value / 1000);
      }
      if (value < 3_600_000) {
        return `${minutes.format(Math.floor(value / 60_000))} ${wholeSeconds.format(
          Math.floor((value % 60_000) / 1000),
        )}`;
      }
      return `${hours.format(Math.floor(value / 3_600_000))} ${minutes.format(
        Math.floor((value % 3_600_000) / 60_000),
      )}`;
    },
    clock: (epochMs) => clock.format(epochMs),
  };
  formats.set(key, format);
  return format;
}

/**
 * A record's duration as the ledger and inspector show it. Running is read from the
 * record's status, not from a missing end: a failed record can lack an end too.
 */
export function recordDurationText(
  node: TraceNode,
  format: TraceFormat,
  runningLabel: string,
): string {
  if (node.record.status === 'running') {
    return runningLabel;
  }
  return node.end == null ? UNKNOWN_DURATION : format.duration(node.end - node.start);
}

/** Formats in the app's language and the user's clock setting, as message timestamps do. */
export function useTraceFormat(): TraceFormat {
  const { i18n } = useTranslation();
  const hour12 = useClockFormat();
  return useMemo(() => createTraceFormat(i18n.language, hour12), [i18n.language, hour12]);
}

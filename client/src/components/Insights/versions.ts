import type { TInsightsAgentVersion } from 'librechat-data-provider';

/** Charts mark only the most recent days with saved versions, so a busy agent stays readable. */
export const versionMarkerLimit = 5;

export type VersionDay = {
  /** The latest version saved on or before this day; null before the first save. */
  inUse: number | null;
  /** Versions saved on this day, oldest first; the last one is the one in use at the day's end. */
  saved: number[];
  /** The day gets a marker: it has saved versions and is one of the last marked days. */
  marked: boolean;
  /** True when today's version is an older one restored after the latest save. */
  restored: boolean;
};

/** Calendar day of an instant in the given time zone, as the daily buckets key it. */
export function dayKey(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Saved versions only carry a date, so a day shows the latest version saved by then. A revert
 *  copies an older version back without always saving a dated entry; the server marks the version
 *  active now, which is shown on today's point only, because the revert's date is unknown. */
export function getVersionDays(
  days: Array<{ date: string }>,
  versions: TInsightsAgentVersion[],
  timeZone: string,
  now: Date = new Date(),
  limit: number = versionMarkerLimit,
): VersionDay[] {
  const dated = versions
    .filter((version) => version.savedAt != null)
    .map((version) => ({
      version: version.version,
      day: dayKey(new Date(version.savedAt as string), timeZone),
    }))
    .sort((left, right) => left.version - right.version);
  const latest = dated.at(-1)?.version ?? null;
  const active = versions.find((version) => version.active)?.version ?? null;
  const today = dayKey(now, timeZone);
  const marked = new Set(
    days
      .map(({ date }) => date)
      .filter((date) => dated.some((version) => version.day === date))
      .slice(-limit),
  );
  return days.map(({ date }) => {
    const restored = date === today && active != null && latest != null && active !== latest;
    const savedBy = dated.filter((version) => version.day <= date);
    return {
      inUse: restored ? active : (savedBy.at(-1)?.version ?? null),
      saved: dated.filter((version) => version.day === date).map((version) => version.version),
      marked: marked.has(date),
      restored,
    };
  });
}

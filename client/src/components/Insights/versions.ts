import type { TInsightsAgentVersion } from 'librechat-data-provider';
import type { useLocalize } from '~/hooks';

export const versionMarkerLimit = 5;

export type VersionDay = {
  inUse: number | null;
  lastSaved: number | null;
  earlierSaved: number;
  marked: boolean;
  restored: boolean;
};

export type VersionMark = { label: string | null; marked: boolean; tag?: string };

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

/** A restore has no saved date, so a restored older version only shows on today's point. */
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
    const savedThatDay = dated.filter((version) => version.day === date);
    return {
      inUse: restored ? active : (savedBy.at(-1)?.version ?? null),
      lastSaved: savedThatDay.at(-1)?.version ?? null,
      earlierSaved: Math.max(0, savedThatDay.length - 1),
      marked: marked.has(date),
      restored,
    };
  });
}

export function tagAnchor(position: number): 'start' | 'center' | 'end' {
  if (position < 8) return 'start';
  if (position > 92) return 'end';
  return 'center';
}

const tagCharPx = 7;
const tagGapPx = 6;

/** Indexes of the tags that fit, newest first; all of them until the chart has been measured. */
export function visibleTags(tags: Array<{ position: number; text: string }>, widthPx: number) {
  const visible = new Set<number>();
  if (widthPx <= 0) {
    tags.forEach((_, index) => visible.add(index));
    return visible;
  }
  let nextStart = Number.POSITIVE_INFINITY;
  for (let index = tags.length - 1; index >= 0; index--) {
    const { position, text } = tags[index];
    const width = text.length * tagCharPx;
    const at = (position / 100) * widthPx;
    const anchor = tagAnchor(position);
    let start = at - width / 2;
    if (anchor === 'start') start = at;
    if (anchor === 'end') start = at - width;
    if (start + width + tagGapPx <= nextStart) {
      visible.add(index);
      nextStart = start;
    }
  }
  return visible;
}

export function getVersionMarks(
  days: VersionDay[],
  localize: ReturnType<typeof useLocalize>,
): VersionMark[] {
  return days.map(({ inUse, lastSaved, earlierSaved, marked, restored }) => {
    if (lastSaved != null) {
      return {
        marked,
        label:
          earlierSaved > 0
            ? localize('com_insights_version_saved_earlier', {
                versionNumber: lastSaved,
                earlier: earlierSaved,
              })
            : localize('com_insights_version_saved_marker', { versionNumber: lastSaved }),
        tag: localize('com_insights_version_tag', { versionNumber: lastSaved }),
      };
    }
    if (inUse == null) return { marked: false, label: null };
    return {
      marked: false,
      label: restored
        ? localize('com_insights_version_restored', { versionNumber: inUse })
        : localize('com_ui_agent_version_title', { versionNumber: inUse }),
    };
  });
}

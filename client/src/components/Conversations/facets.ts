import { useEffect } from 'react';
import { atom, useSetAtom } from 'jotai';
import type { ConversationListParams } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

/** Coarse windows, matching the headings the list already groups chats under. */
export type DateRange = 'any' | 'today' | 'week' | 'month' | 'year';

export const DATE_RANGE_OPTIONS: Array<{ value: DateRange; label: TranslationKeys }> = [
  { value: 'any', label: 'com_ui_any_time' },
  { value: 'today', label: 'com_ui_date_today' },
  { value: 'week', label: 'com_ui_date_previous_7_days' },
  { value: 'month', label: 'com_ui_date_previous_30_days' },
  { value: 'year', label: 'com_ui_date_previous_year' },
];

/** How many whole days back each window starts, counting today as the first. */
const RANGE_DAYS: Record<Exclude<DateRange, 'any'>, number> = {
  today: 1,
  week: 7,
  month: 30,
  year: 365,
};

/**
 * The instant a window starts, snapped to local midnight.
 *
 * Snapping is not cosmetic. The cutoff travels in the query key, so a cutoff derived
 * from the current instant would differ on every render and refetch the list each
 * time. Anchored to midnight it is stable for the whole day, which is also what
 * "previous 7 days" means to the person reading it.
 */
export function rangeCutoff(range: DateRange, now: Date = new Date()): Date | undefined {
  if (range === 'any') {
    return undefined;
  }
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  startOfToday.setDate(startOfToday.getDate() - (RANGE_DAYS[range] - 1));
  return startOfToday;
}

const startOfLocalDay = (now: Date = new Date()): number =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

/**
 * The local midnight the cutoffs are anchored to, as a timestamp. A derived atom would
 * otherwise cache a cutoff computed yesterday and keep serving it until a facet changes,
 * so the anchor is its own atom that a mounted consumer advances at midnight.
 */
export const localDayStartAtom = atom(startOfLocalDay());

/**
 * Advances the day anchor when the local day changes, then sleeps until the next
 * midnight. One mounted consumer is enough for every reader of the cutoffs; a day with
 * no date facet selected costs a single timer that fires once.
 */
export function useFreshLocalDay(): void {
  const setDay = useSetAtom(localDayStartAtom);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const now = new Date();
      const todayStart = startOfLocalDay(now);
      setDay((previous) => (previous === todayStart ? previous : todayStart));
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(check, Math.max(0, nextMidnight.getTime() - Date.now()) + 500);
    };
    check();
    return () => {
      if (timer != null) {
        clearTimeout(timer);
      }
    };
  }, [setDay]);
}

export const updatedRangeAtom = atom<DateRange>('any');
export const createdRangeAtom = atom<DateRange>('any');

/** OR-matched: a chat qualifies if it ran on any of the chosen endpoints. */
export const endpointFilterAtom = atom<string[]>([]);

export const hasAttachmentsAtom = atom(false);

/** Chats the user is actively sharing through a link. */
export const sharedOnlyAtom = atom(false);

export const toggleEndpointFilterAtom = atom(null, (get, set, endpoint: string) => {
  const endpoints = get(endpointFilterAtom);
  set(
    endpointFilterAtom,
    endpoints.includes(endpoint)
      ? endpoints.filter((current) => current !== endpoint)
      : [...endpoints, endpoint],
  );
});

/** One facet narrowing the list counts once, however many values it carries. */
export const facetFilterCountAtom = atom((get) => {
  let count = 0;
  if (get(updatedRangeAtom) !== 'any') {
    count += 1;
  }
  if (get(createdRangeAtom) !== 'any') {
    count += 1;
  }
  if (get(endpointFilterAtom).length > 0) {
    count += 1;
  }
  if (get(hasAttachmentsAtom)) {
    count += 1;
  }
  if (get(sharedOnlyAtom)) {
    count += 1;
  }
  return count;
});

/**
 * The facets as the list query takes them. Derived rather than assembled at the call
 * site so the query key and the request are built from one description of the filter,
 * and an unset facet is absent rather than sent as an empty value.
 */
export const chatFacetParamsAtom = atom<
  Pick<
    ConversationListParams,
    'updatedAfter' | 'createdAfter' | 'endpoints' | 'hasFiles' | 'sharedOnly'
  >
>((get) => {
  /** Anchored to the advancing day rather than `new Date()`: the cutoff must be stable
   *  within a day (it is the query key) yet must not outlive the day it names. */
  const day = new Date(get(localDayStartAtom));
  const updatedAfter = rangeCutoff(get(updatedRangeAtom), day);
  const createdAfter = rangeCutoff(get(createdRangeAtom), day);
  const endpoints = get(endpointFilterAtom);
  const hasFiles = get(hasAttachmentsAtom);
  const sharedOnly = get(sharedOnlyAtom);

  return {
    updatedAfter: updatedAfter?.toISOString(),
    createdAfter: createdAfter?.toISOString(),
    endpoints: endpoints.length > 0 ? endpoints : undefined,
    hasFiles: hasFiles ? true : undefined,
    sharedOnly: sharedOnly ? true : undefined,
  };
});

export const resetFacetsAtom = atom(null, (_get, set) => {
  set(updatedRangeAtom, 'any');
  set(createdRangeAtom, 'any');
  set(endpointFilterAtom, []);
  set(hasAttachmentsAtom, false);
  set(sharedOnlyAtom, false);
});

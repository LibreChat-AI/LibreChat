import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import type { WeekStartDay } from '~/utils/clock';
import { resolveWeekStartsOn, systemLocale } from '~/utils/clock';
import { weekStartAtom } from '~/store/weekStart';

/** Resolves the "Week starts on" setting to a concrete day index (0 = Sunday,
 *  1 = Monday). Its 'system' branch reads the RUNTIME locale for the same reason
 *  `useClockFormat` does: `en-GB` normalizes to `en` and would report Sunday. */
export default function useWeekStart(): WeekStartDay {
  const preference = useAtomValue(weekStartAtom);
  return useMemo(() => resolveWeekStartsOn(preference, systemLocale()), [preference]);
}

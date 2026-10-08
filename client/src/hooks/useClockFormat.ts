import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { resolveHour12, systemLocale } from '~/utils/clock';
import { clockFormatAtom } from '~/store/clockFormat';

/** Resolves the "Clock format" setting to a concrete `hour12` boolean. The
 *  'system' branch reads the RUNTIME locale rather than `i18n.language`, which is
 *  normalized to a translation bundle and no longer carries the region the
 *  convention depends on (see `systemLocale`). */
export default function useClockFormat(): boolean {
  const preference = useAtomValue(clockFormatAtom);
  return useMemo(() => resolveHour12(preference, systemLocale()), [preference]);
}

import { useAtom } from 'jotai';
import { Dropdown } from '@librechat/client';
import type { WeekStartPreference } from '~/store/weekStart';
import { weekStartAtom } from '~/store/weekStart';
import { useLocalize } from '~/hooks';

export default function WeekStartSelector() {
  const localize = useLocalize();
  const [weekStart, setWeekStart] = useAtom(weekStartAtom);

  const options = [
    { value: 'system', label: localize('com_nav_week_start_system') },
    { value: 'sunday', label: localize('com_nav_week_start_sunday') },
    { value: 'monday', label: localize('com_nav_week_start_monday') },
  ];

  const labelId = 'week-start-selector-label';

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div id={labelId}>{localize('com_nav_week_start')}</div>
      <Dropdown
        value={weekStart}
        options={options}
        onChange={(value) => setWeekStart(value as WeekStartPreference)}
        testId="week-start-selector"
        sizeClasses="z-50 w-[150px]"
        className="z-50"
        aria-labelledby={labelId}
      />
    </div>
  );
}

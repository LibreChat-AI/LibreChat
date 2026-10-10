import { useAtom } from 'jotai';
import { Dropdown } from '@librechat/client';
import type { ClockFormatPreference } from '~/store/clockFormat';
import { clockFormatAtom } from '~/store/clockFormat';
import { useLocalize } from '~/hooks';

export default function ClockFormatSelector() {
  const localize = useLocalize();
  const [clockFormat, setClockFormat] = useAtom(clockFormatAtom);

  const options = [
    { value: 'system', label: localize('com_nav_clock_format_system') },
    { value: '12h', label: localize('com_nav_clock_format_12h') },
    { value: '24h', label: localize('com_nav_clock_format_24h') },
  ];

  const labelId = 'clock-format-selector-label';

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div id={labelId}>{localize('com_nav_clock_format')}</div>
      <Dropdown
        value={clockFormat}
        options={options}
        onChange={(value) => setClockFormat(value as ClockFormatPreference)}
        testId="clock-format-selector"
        sizeClasses="z-50 w-[150px]"
        className="z-50"
        aria-labelledby={labelId}
      />
    </div>
  );
}

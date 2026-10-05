import { useAtom } from 'jotai';
import { Dropdown } from '@librechat/client';
import { fontSizeAtom } from '~/store/fontSize';
import { useLocalize } from '~/hooks';

export default function FontSizeSelector() {
  const localize = useLocalize();
  const [fontSize, setFontSize] = useAtom(fontSizeAtom);

  const handleChange = (val: string) => {
    setFontSize(val);
  };

  const options = [
    { value: 'text-xs', label: localize('com_nav_font_size_xs') },
    { value: 'text-sm', label: localize('com_nav_font_size_sm') },
    { value: 'text-base', label: localize('com_nav_font_size_base') },
    { value: 'text-lg', label: localize('com_nav_font_size_lg') },
    { value: 'text-xl', label: localize('com_nav_font_size_xl') },
  ];

  const labelId = 'font-size-selector-label';

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div id={labelId}>{localize('com_nav_font_size')}</div>
      <Dropdown
        value={fontSize}
        options={options}
        onChange={handleChange}
        testId="font-size-selector"
        sizeClasses="z-50 w-[9.375rem]"
        className="z-50"
        aria-labelledby={labelId}
      />
    </div>
  );
}

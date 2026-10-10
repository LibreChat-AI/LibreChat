import { useRecoilValue } from 'recoil';
import { SettingsViews } from 'librechat-data-provider';
import type { TSettingsProps } from '~/common';
import { Advanced } from './Settings';
import { cn } from '~/utils';
import store from '~/store';

export default function AlternativeSettings({
  conversation,
  setOption,
  isPreset = false,
  className = '',
}: TSettingsProps) {
  const currentSettingsView = useRecoilValue(store.currentSettingsView);
  if (!conversation?.endpoint || currentSettingsView === SettingsViews.default) {
    return null;
  }

  return (
    <div
      className={cn(
        'hide-scrollbar h-[min(31.25rem,70vh)] overflow-y-auto md:mb-2 md:h-[min(21.875rem,70vh)]',
        className,
      )}
    >
      <Advanced conversation={conversation} setOption={setOption} isPreset={isPreset} />
    </div>
  );
}

import type { SkillItem } from '../../items/types';
import { useLocalize } from '~/hooks';

interface Props {
  item: SkillItem;
}

export default function SkillSection({ item }: Props) {
  const localize = useLocalize();
  return (
    <div className="flex flex-col gap-5">
      {item.description ? (
        <p className="text-text-secondary max-h-40 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap">
          {item.description}
        </p>
      ) : (
        <p className="text-text-tertiary text-sm italic">
          {localize('com_ui_tools_no_description')}
        </p>
      )}
      <div className="border-border-light bg-surface-secondary text-text-secondary rounded-xl border px-4 py-3 text-xs">
        <span className="text-text-tertiary block font-medium tracking-wide uppercase">
          {localize('com_ui_tools_info_identifier')}
        </span>
        <span className="text-text-primary block truncate font-mono">{item.id}</span>
      </div>
    </div>
  );
}

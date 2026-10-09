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
        <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">
          {item.description}
        </p>
      ) : (
        <p className="text-sm italic text-text-tertiary">
          {localize('com_ui_tools_no_description')}
        </p>
      )}
      <div className="rounded-xl border border-border-light bg-surface-secondary px-4 py-3 text-xs text-text-secondary">
        <span className="block font-medium uppercase tracking-wide text-text-tertiary">
          {localize('com_ui_tools_info_identifier')}
        </span>
        <span className="block truncate font-mono text-text-primary">{item.id}</span>
      </div>
    </div>
  );
}

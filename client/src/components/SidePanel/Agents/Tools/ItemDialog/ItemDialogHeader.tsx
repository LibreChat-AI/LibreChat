import { useState } from 'react';
import { OGDialogHeader, OGDialogTitle, OGDialogDescription } from '@librechat/client';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { AgentItem } from '../items/types';
import { getIconForItem } from '../items/icons';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const KIND_LABEL_KEYS: Record<AgentItem['kind'], TranslationKeys> = {
  builtin: 'com_ui_tools_kind_official',
  tool: 'com_ui_tools_kind_tools',
  skill: 'com_ui_tools_kind_skills',
  mcp: 'com_ui_tools_kind_mcp',
  action: 'com_ui_tools_kind_actions',
};

function HeaderIcon({ item }: { item: AgentItem }) {
  const { Icon, colorClass, iconUrl } = getIconForItem(item);
  const [imgError, setImgError] = useState(false);

  if (iconUrl && !imgError) {
    return (
      <span
        className="bg-surface-fixed flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl"
        aria-hidden="true"
      >
        <img
          src={iconUrl}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setImgError(true)}
        />
      </span>
    );
  }

  return (
    <span
      className={cn('flex size-12 shrink-0 items-center justify-center rounded-2xl', colorClass)}
      aria-hidden="true"
    >
      <Icon className="size-5" strokeWidth={1.75} />
    </span>
  );
}

export default function ItemDialogHeader({ item }: { item: AgentItem }) {
  const localize = useLocalize();
  const displayName = item.kind === 'builtin' ? localize(item.name as TranslationKeys) : item.name;
  const kindLabel = localize(KIND_LABEL_KEYS[item.kind]);

  return (
    <OGDialogHeader className="flex flex-row items-center gap-3 space-y-0 px-6 pt-5 pb-4 text-left">
      <HeaderIcon item={item} />
      <div className="min-w-0 flex-1">
        <OGDialogTitle className="text-text-primary truncate text-base font-semibold">
          {displayName}
        </OGDialogTitle>
        <OGDialogDescription className="text-text-secondary m-0 text-[11px] tracking-wide uppercase">
          {kindLabel}
        </OGDialogDescription>
      </div>
    </OGDialogHeader>
  );
}

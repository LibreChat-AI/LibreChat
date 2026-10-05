import { useId, useMemo, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { ArrowUpDown, Check } from 'lucide-react';
import { DropdownPopup } from '@librechat/client';
import type { MenuItemProps, RenderProp } from '~/common';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export type ProjectSort = 'name' | 'createdAt' | 'lastConversationAt';

type ProjectsSortMenuProps = {
  sortBy: ProjectSort;
  onSortChange: (sortBy: ProjectSort) => void;
};

function renderSortMenuItem(label: string, isSelected: boolean): RenderProp {
  return function SortMenuItem({ className, ...props }) {
    return (
      <div {...props} className={cn(className, 'justify-between gap-5')}>
        <span className="truncate">{label}</span>
        {isSelected ? (
          <Check className="text-text-primary h-4 w-4 shrink-0" aria-hidden="true" />
        ) : (
          <span className="h-4 w-4 shrink-0" aria-hidden="true" />
        )}
      </div>
    );
  };
}

export default function ProjectsSortMenu({ sortBy, onSortChange }: ProjectsSortMenuProps) {
  const localize = useLocalize();
  const sortMenuId = useId();
  const [isOpen, setIsOpen] = useState(false);

  const sortOptions = useMemo(
    () => [
      { value: 'lastConversationAt' as const, label: localize('com_ui_latest_activity') },
      { value: 'createdAt' as const, label: localize('com_ui_sort_created') },
      { value: 'name' as const, label: localize('com_ui_name') },
    ],
    [localize],
  );
  const selectedSortLabel =
    sortOptions.find((option) => option.value === sortBy)?.label ??
    localize('com_ui_latest_activity');
  const sortMenuItems = useMemo<MenuItemProps[]>(
    () =>
      sortOptions.map((option) => {
        const isSelected = sortBy === option.value;
        return {
          id: `project-sort-${option.value}`,
          ariaLabel: option.label,
          ariaChecked: isSelected,
          onClick: () => onSortChange(option.value),
          render: renderSortMenuItem(option.label, isSelected),
        };
      }),
    [onSortChange, sortBy, sortOptions],
  );

  return (
    <DropdownPopup
      portal={true}
      focusLoop={true}
      unmountOnHide={true}
      menuId={sortMenuId}
      isOpen={isOpen}
      setIsOpen={setIsOpen}
      className="z-[125]"
      minWidth="14rem"
      trigger={
        <Ariakit.MenuButton
          aria-label={localize('com_ui_sort_projects_by')}
          className={cn(
            'text-text-secondary inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-lg px-2 text-sm font-medium transition-colors',
            'hover:bg-surface-hover hover:text-text-primary',
            'focus-visible:ring-text-primary focus-visible:ring-2 focus-visible:outline-hidden',
            isOpen && 'bg-surface-hover text-text-primary',
          )}
        >
          <ArrowUpDown className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{selectedSortLabel}</span>
        </Ariakit.MenuButton>
      }
      items={sortMenuItems}
    />
  );
}

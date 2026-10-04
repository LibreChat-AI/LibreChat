import { useState, useId, useMemo } from 'react';
import { ListFilter } from 'lucide-react';
import * as Menu from '@ariakit/react/menu';
import { DropdownPopup } from '@librechat/client';
import { useReactTable } from '@tanstack/react-table';
import { useLocalize, TranslationKeys } from '~/hooks';
import { cn } from '~/utils';

interface ColumnVisibilityDropdownProps<TData> {
  table: ReturnType<typeof useReactTable<TData>>;
  contextMap: Record<string, TranslationKeys>;
  isSmallScreen: boolean;
}

export function ColumnVisibilityDropdown<TData>({
  table,
  contextMap,
  isSmallScreen,
}: ColumnVisibilityDropdownProps<TData>) {
  const localize = useLocalize();
  const menuId = useId();
  const [isOpen, setIsOpen] = useState(false);

  const dropdownItems = useMemo(
    () =>
      table
        .getAllColumns()
        .filter((column) => column.getCanHide())
        .map((column) => ({
          label: localize(contextMap[column.id]),
          onClick: () => column.toggleVisibility(!column.getIsVisible()),
          icon: column.getIsVisible() ? '✓' : '',
          id: column.id,
        })),
    [table, contextMap, localize],
  );

  return (
    <DropdownPopup
      portal={false}
      isOpen={isOpen}
      setIsOpen={setIsOpen}
      trigger={
        <Menu.MenuButton
          aria-label={localize('com_files_filter_by')}
          className={cn(
            'border-border-medium ring-offset-surface-primary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-text-primary inline-flex h-9 items-center justify-center gap-2 rounded-md border bg-transparent px-3 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50',
            isSmallScreen && 'px-2 py-1',
          )}
        >
          <ListFilter className="size-3.5 sm:size-4" aria-hidden="true" />
        </Menu.MenuButton>
      }
      items={dropdownItems}
      menuId={menuId}
      className="z-50 max-h-[300px] overflow-y-auto"
    />
  );
}

import { useState, useId, useMemo } from 'react';
import * as Menu from '@ariakit/react/menu';
import { Column } from '@tanstack/react-table';
import { ListFilter, FilterX } from 'lucide-react';
import { DropdownPopup, TooltipAnchor } from '@librechat/client';
import { ArrowDownIcon, ArrowUpIcon, CaretSortIcon } from '@radix-ui/react-icons';
import type { MenuItemProps } from '~/common';
import { useLocalize, TranslationKeys } from '~/hooks';
import { cn } from '~/utils';

interface SortFilterHeaderProps<TData, TValue> extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  column: Column<TData, TValue>;
  filters?: Record<string, string[] | number[]>;
  valueMap?: Record<any, TranslationKeys>;
  ariaLabel?: string;
}

export function SortFilterHeader<TData, TValue>({
  column,
  title,
  className = '',
  filters,
  valueMap,
  ariaLabel,
}: SortFilterHeaderProps<TData, TValue>) {
  const localize = useLocalize();
  const menuId = useId();
  const [isOpen, setIsOpen] = useState(false);

  const dropdownItems = useMemo(() => {
    const items: MenuItemProps[] = [
      {
        label: localize('com_ui_ascending'),
        onClick: () => column.toggleSorting(false),
        icon: <ArrowUpIcon className="icon-sm text-text-secondary" />,
      },
      {
        label: localize('com_ui_descending'),
        onClick: () => column.toggleSorting(true),
        icon: <ArrowDownIcon className="icon-sm text-text-secondary" />,
      },
    ];

    if (filters) {
      items.push({ separate: true } as any);
      Object.entries(filters).forEach(([_key, values]) => {
        values.forEach((value?: string | number) => {
          const translationKey = valueMap?.[value ?? ''];
          const filterValue =
            translationKey != null && translationKey.length
              ? localize(translationKey)
              : String(value);
          if (filterValue) {
            const isActive = column.getFilterValue() === value;
            items.push({
              label: filterValue,
              onClick: () => column.setFilterValue(value),
              icon: <ListFilter className="icon-sm text-text-secondary" aria-hidden="true" />,
              show: true,
              className: isActive ? 'border-l-2 border-l-border-xheavy' : '',
            });
          }
        });
      });

      items.push({ separate: true } as any);
      items.push({
        label: localize('com_ui_show_all'),
        onClick: () => column.setFilterValue(undefined),
        icon: <FilterX className="icon-sm text-text-secondary" />,
        show: true,
      });
    }

    return items;
  }, [column, filters, valueMap, localize]);

  if (!column.getCanSort()) {
    return <div className={cn(className)}>{title}</div>;
  }

  const sortState = column.getIsSorted();
  let ariaSort: 'ascending' | 'descending' | 'none' = 'none';
  if (sortState === 'desc') {
    ariaSort = 'descending';
  } else if (sortState === 'asc') {
    ariaSort = 'ascending';
  }

  return (
    <div className={cn('flex items-center space-x-2', className)}>
      <DropdownPopup
        portal={false}
        isOpen={isOpen}
        setIsOpen={setIsOpen}
        trigger={
          <TooltipAnchor
            description={ariaLabel || title}
            side="top"
            render={
              <Menu.MenuButton
                aria-sort={ariaSort}
                aria-label={ariaLabel}
                aria-pressed={column.getIsFiltered() ? 'true' : 'false'}
                aria-current={sortState ? 'true' : 'false'}
                className={cn(
                  'hover:bg-surface-hover focus-visible:ring-text-primary data-[open]:bg-surface-hover inline-flex items-center gap-2 rounded-lg px-2 py-0 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-hidden sm:px-2 sm:py-2 sm:text-sm',
                  column.getIsFiltered() && 'border-b-border-xheavy border-b-2',
                )}
              >
                <span>{title}</span>
                {column.getIsFiltered() ? (
                  <ListFilter className="icon-sm" aria-hidden="true" />
                ) : (
                  <ListFilter className="icon-sm text-text-secondary" aria-hidden="true" />
                )}
                {(() => {
                  const sortState = column.getIsSorted();
                  if (sortState === 'desc') {
                    return <ArrowDownIcon className="icon-sm" />;
                  }
                  if (sortState === 'asc') {
                    return <ArrowUpIcon className="icon-sm" />;
                  }
                  return <CaretSortIcon className="icon-sm" />;
                })()}
              </Menu.MenuButton>
            }
          />
        }
        items={dropdownItems}
        menuId={menuId}
        className="z-[1001]"
      />
    </div>
  );
}

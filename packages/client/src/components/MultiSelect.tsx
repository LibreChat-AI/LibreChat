import React, { useMemo, useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { SelectRenderer } from '@ariakit/react-components/select/select-renderer';
import {
  Select,
  SelectArrow,
  SelectItem,
  SelectItemCheck,
  SelectLabel,
  SelectList,
  SelectPopover,
  SelectProvider,
} from '@ariakit/react';
import type { SelectRendererBaseItemProps } from '@ariakit/react-components/select/select-renderer';
import useRemScale from '~/hooks/useRemScale';
import './AnimatePopover.css';
import { JSX } from 'react/jsx-runtime';
import { cn, disabledFillClasses } from '~/utils';

type MultiSelectItem<T extends string> = T | { label: string; value: T };

function getItemValue<T extends string>(item: MultiSelectItem<T>): T {
  return typeof item === 'string' ? item : item.value;
}

function getItemLabel<T extends string>(item: MultiSelectItem<T>): string {
  return typeof item === 'string' ? item : item.label;
}

interface MultiSelectProps<T extends string> {
  items: MultiSelectItem<T>[];
  label?: string;
  placeholder?: string;
  onSelectedValuesChange?: (values: T[]) => void;
  renderSelectedValues?: (
    values: T[],
    placeholder?: string,
    items?: MultiSelectItem<T>[],
  ) => React.ReactNode;
  className?: string;
  itemClassName?: string;
  labelClassName?: string;
  selectClassName?: string;
  selectIcon?: React.ReactNode;
  popoverClassName?: string;
  /** `widget` paints the popover in the dashboard widget surface (`chart-widget-surface`), for a
   *  picker that opens over chart widgets; `default` keeps the shared menu surface. */
  surface?: 'default' | 'widget';
  selectItemsClassName?: string;
  selectedValues: T[];
  setSelectedValues: (values: T[]) => void;
  renderItemContent?: (
    value: T,
    defaultContent: React.ReactNode,
    isSelected: boolean,
  ) => React.ReactNode;
  popoverHeader?: React.ReactNode;
  searchPlaceholder?: string;
  searchEmptyText?: string;
  disabled?: boolean;
  showSelectedValues?: boolean;
  showItemCheckboxes?: boolean;
  /** Window large lists while keeping search and keyboard access to every option. */
  virtualized?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function defaultRender<T extends string>(
  values: T[],
  placeholder?: string,
  items?: MultiSelectItem<T>[],
) {
  if (values.length === 0) {
    return placeholder || 'Select...';
  }
  if (values.length === 1) {
    // Find the item to get its label
    if (items) {
      const item = items.find((item) => getItemValue(item) === values[0]);
      if (item) {
        return getItemLabel(item);
      }
    }
    return values[0];
  }
  return `${values.length} items selected`;
}

export default function MultiSelect<T extends string>({
  items,
  label,
  placeholder = 'Select...',
  onSelectedValuesChange,
  renderSelectedValues = defaultRender,
  className,
  selectIcon,
  itemClassName,
  labelClassName,
  selectClassName,
  popoverClassName,
  surface = 'default',
  selectItemsClassName,
  selectedValues = [],
  setSelectedValues,
  renderItemContent,
  popoverHeader,
  searchPlaceholder,
  searchEmptyText,
  disabled = false,
  showSelectedValues = false,
  showItemCheckboxes = false,
  virtualized = false,
  onOpenChange,
}: MultiSelectProps<T>): JSX.Element {
  const selectRef = useRef<HTMLButtonElement>(null);
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [search, setSearch] = useState('');
  const remScale = useRemScale();
  const visibleItems = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items
      .filter((item) => getItemLabel(item).toLowerCase().includes(needle))
      .map((item) => ({ value: getItemValue(item), label: getItemLabel(item) }));
  }, [items, search]);

  const handleValueChange = (values: T[]) => {
    setSelectedValues(values);
    if (onSelectedValuesChange) {
      onSelectedValuesChange(values);
    }
  };

  const handleOpenChange = (open: boolean) => {
    setIsPopoverOpen(open);
    if (!open) {
      setSearch('');
    }
    if (onOpenChange) {
      onOpenChange(open);
    }
  };

  const renderOption = ({
    value,
    label,
    ...props
  }: Partial<SelectRendererBaseItemProps> & { value: T; label: string }) => {
    const isCurrentItemSelected = selectedValues.includes(value);
    const defaultContent = (
      <>
        {showItemCheckboxes ? (
          <span
            aria-hidden="true"
            className={cn(
              'border-border-xheavy flex size-4 shrink-0 items-center justify-center rounded-sm border',
              isCurrentItemSelected && 'bg-surface-inverted text-text-inverted',
            )}
          >
            {isCurrentItemSelected && <Check className="size-3.5" strokeWidth={2} />}
          </span>
        ) : (
          <SelectItemCheck className="text-text-primary me-0.5" />
        )}
        <span className="truncate">{label}</span>
      </>
    );
    return (
      <SelectItem
        key={value}
        {...props}
        value={value}
        aria-label={label}
        className={cn(
          'flex items-center gap-2 rounded-lg px-2 py-1.5 hover:cursor-pointer',
          'scroll-m-1 outline-hidden transition-colors',
          'hover:bg-surface-hover',
          'data-[active-item]:bg-surface-active',
          'w-full min-w-0 text-sm',
          itemClassName,
        )}
      >
        {renderItemContent
          ? (renderItemContent(value, defaultContent, isCurrentItemSelected) as React.JSX.Element)
          : (defaultContent as React.JSX.Element)}
      </SelectItem>
    );
  };

  return (
    <div className={className}>
      <SelectProvider
        value={selectedValues}
        setValue={handleValueChange}
        open={isPopoverOpen}
        setOpen={handleOpenChange}
      >
        {label && (
          <SelectLabel className={cn('text-text-primary mb-1 block text-sm', labelClassName)}>
            {label}
          </SelectLabel>
        )}
        <Select
          ref={selectRef}
          disabled={disabled}
          data-state={isPopoverOpen ? 'open' : 'closed'}
          className={cn(
            'flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm',
            'bg-surface-tertiary text-text-primary hover:bg-surface-hover shadow-xs hover:cursor-pointer',
            'disabled:hover:bg-surface-tertiary disabled:cursor-not-allowed disabled:opacity-60',
            disabledFillClasses,
            'focus-visible:ring-focus-control outline-hidden focus-visible:ring-2 focus-visible:outline-hidden',
            selectClassName,
            selectedValues.length > 0 && selectItemsClassName != null && selectItemsClassName,
          )}
          onChange={(e) => e.stopPropagation()}
        >
          {selectIcon && <span>{selectIcon as React.JSX.Element}</span>}
          <span className={cn('me-auto truncate', !showSelectedValues && 'hidden md:block')}>
            {renderSelectedValues(selectedValues, placeholder, items)}
          </span>
          <SelectArrow
            className={cn(
              'ms-1 stroke-1 text-base opacity-75 transition-transform duration-300',
              !showSelectedValues && 'hidden md:block',
              isPopoverOpen && 'rotate-180',
            )}
          />
        </Select>
        <SelectPopover
          role="dialog"
          aria-label={label || placeholder}
          gutter={4}
          sameWidth
          modal
          unmountOnHide
          finalFocus={selectRef}
          className={cn(
            'animate-popover z-40 flex max-h-[18.75rem]',
            'rounded-theme-menu-panel flex-col overflow-auto overscroll-contain',
            'bg-surface-secondary text-text-primary px-1.5 py-1 shadow-lg',
            'border-border-light border',
            'outline-hidden',
            surface === 'widget' && 'bg-chart-widget-surface',
            popoverClassName,
          )}
        >
          <div className="shrink-0">
            {searchPlaceholder && (
              <div className="border-border-light flex items-center gap-2 border-b px-4 py-2">
                <Search aria-hidden="true" className="text-text-secondary size-4 shrink-0" />
                <input
                  aria-label={searchPlaceholder}
                  placeholder={searchPlaceholder}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="focus-visible:ring-focus-control min-w-0 flex-1 bg-transparent text-sm outline-hidden focus-visible:ring-2"
                />
              </div>
            )}
            {popoverHeader}
          </div>
          <SelectList className="min-h-0 overflow-y-auto overscroll-contain">
            {virtualized ? (
              <SelectRenderer
                items={visibleItems}
                value={selectedValues[0] ?? ''}
                estimatedItemSize={32 * remScale}
                overscan={5}
              >
                {renderOption}
              </SelectRenderer>
            ) : (
              visibleItems.map(renderOption)
            )}
          </SelectList>
          {visibleItems.length === 0 && searchEmptyText && (
            <div role="status" className="text-text-secondary px-4 py-3 text-sm">
              {searchEmptyText}
            </div>
          )}
        </SelectPopover>
      </SelectProvider>
    </div>
  );
}

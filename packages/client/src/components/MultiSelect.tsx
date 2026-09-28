import React, { useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';
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
import './AnimatePopover.css';
import { JSX } from 'react/jsx-runtime';
import { cn } from '~/utils';

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
  onOpenChange,
}: MultiSelectProps<T>): JSX.Element {
  const selectRef = useRef<HTMLButtonElement>(null);
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [search, setSearch] = useState('');
  const visibleItems = items.filter((item) =>
    getItemLabel(item).toLowerCase().includes(search.trim().toLowerCase()),
  );

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

  return (
    <div className={className}>
      <SelectProvider
        value={selectedValues}
        setValue={handleValueChange}
        open={isPopoverOpen}
        setOpen={handleOpenChange}
      >
        {label && (
          <SelectLabel className={cn('mb-1 block text-sm text-text-primary', labelClassName)}>
            {label}
          </SelectLabel>
        )}
        <Select
          ref={selectRef}
          disabled={disabled}
          data-state={isPopoverOpen ? 'open' : 'closed'}
          className={cn(
            'flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm',
            'bg-surface-tertiary text-text-primary shadow-sm hover:cursor-pointer hover:bg-surface-hover',
            'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-surface-tertiary',
            'outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary',
            selectClassName,
            selectedValues.length > 0 && selectItemsClassName != null && selectItemsClassName,
          )}
          onChange={(e) => e.stopPropagation()}
        >
          {selectIcon && <span>{selectIcon as React.JSX.Element}</span>}
          <span className={cn('mr-auto truncate', !showSelectedValues && 'hidden md:block')}>
            {renderSelectedValues(selectedValues, placeholder, items)}
          </span>
          <SelectArrow
            className={cn(
              'ml-1 stroke-1 text-base opacity-75 transition-transform duration-300',
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
            'animate-popover z-40 flex max-h-[300px]',
            'flex-col overflow-hidden rounded-xl',
            'bg-surface-secondary px-1.5 py-1 text-text-primary shadow-lg',
            'border border-border-light',
            'outline-none',
            popoverClassName,
          )}
        >
          <div className="shrink-0">
            {searchPlaceholder && (
              <div className="flex items-center gap-2 border-b border-border-light px-4 py-2">
                <Search aria-hidden="true" className="size-4 shrink-0 text-text-secondary" />
                <input
                  aria-label={searchPlaceholder}
                  placeholder={searchPlaceholder}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none focus-visible:ring-2 focus-visible:ring-text-primary"
                />
              </div>
            )}
            {popoverHeader}
          </div>
          <SelectList className="min-h-0 overflow-y-auto overscroll-contain">
            {visibleItems.map((item) => {
              const value = getItemValue(item);
              const label = getItemLabel(item);
              const isCurrentItemSelected = selectedValues.includes(value);
              const defaultContent = (
                <>
                  {showItemCheckboxes ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded-sm border border-border-xheavy',
                        isCurrentItemSelected && 'bg-surface-inverted text-text-inverted',
                      )}
                    >
                      {isCurrentItemSelected && <Check className="size-3.5" strokeWidth={2} />}
                    </span>
                  ) : (
                    <SelectItemCheck className="mr-0.5 text-text-primary" />
                  )}
                  <span className="truncate">{label}</span>
                </>
              );
              return (
                <SelectItem
                  key={value}
                  value={value}
                  aria-label={label}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-2 py-1.5 hover:cursor-pointer',
                    'scroll-m-1 outline-none transition-colors',
                    'hover:bg-surface-hover',
                    'data-[active-item]:bg-surface-active',
                    'w-full min-w-0 text-sm',
                    itemClassName,
                  )}
                >
                  {renderItemContent
                    ? (renderItemContent(
                        value,
                        defaultContent,
                        isCurrentItemSelected,
                      ) as React.JSX.Element)
                    : (defaultContent as React.JSX.Element)}
                </SelectItem>
              );
            })}
          </SelectList>
          {visibleItems.length === 0 && searchEmptyText && (
            <div role="status" className="px-4 py-3 text-sm text-text-secondary">
              {searchEmptyText}
            </div>
          )}
        </SelectPopover>
      </SelectProvider>
    </div>
  );
}
